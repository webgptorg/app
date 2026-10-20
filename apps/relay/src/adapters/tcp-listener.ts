import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer } from 'node:net';

import type { Hostname, RelayId } from '@ptbk/protocol';
import { createClientHelloBuffer } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import { parseIpAddress } from '../domain/ip-address';
import type { EngineLimits } from '../domain/limits/engine-limiter';
import { createEngineLimiter } from '../domain/limits/engine-limiter';
import type { IpLimits } from '../domain/limits/ip-limiter';
import { createIpLimiter } from '../domain/limits/ip-limiter';
import type { Logger } from '../domain/logger';
import type { RefusalReason } from '../domain/metrics/refusal-counters';
import { createRefusalCounters } from '../domain/metrics/refusal-counters';
import type { DailyTraffic } from '../domain/metrics/traffic-counters';
import { createTrafficCounters } from '../domain/metrics/traffic-counters';
import type { ClientHelloVerdict } from '../domain/routing/route-connection';
import { routeConnection } from '../domain/routing/route-connection';
import type { StreamScheduler } from '../domain/routing/stream-scheduler';
import { createStreamScheduler } from '../domain/routing/stream-scheduler';
import type { SessionTable } from '../domain/tunnel/session-table';
import type { TunnelSession } from '../domain/tunnel/tunnel-session';
import type { OwnTlsServer } from './own-tls-server';
import { clientIp } from './own-tls-server';
import type { SocketStreamPipe } from './socket-stream-pipe';
import { pipeSocketToStream } from './socket-stream-pipe';

/** R-01's bound: a ClientHello that does not fit is refused as `too-large`. */
export const CLIENT_HELLO_MAX_BYTES = 16_384;
/** Streams have no idle timeout (SSE and WebSockets live long); keepalive finds browsers that vanished. */
export const BROWSER_KEEPALIVE_MS = 60_000;
/** Today and yesterday, so a day's totals survive until I-04 reads them after midnight. */
const TRAFFIC_RETAIN_DAYS = 2;

export interface BrowserListenerLimits extends IpLimits {
    readonly clientHelloTimeoutMs: number;
    readonly maxStreamsPerEngine: number;
    readonly newStreamsPerEnginePerS: number;
    readonly engineBandwidthBytesPerS: number;
}

export interface BrowserListenerOptions {
    readonly relayId: RelayId;
    readonly engineDomain: Hostname;
    readonly sessions: SessionTable<TunnelSession>;
    /** R-03's TLS server, for connections to the relay's own hostname. */
    readonly own: Pick<OwnTlsServer, 'acceptSocket'>;
    readonly limits: BrowserListenerLimits;
    /** ClientHello deadlines and the token buckets. */
    readonly clock: Clock;
    readonly logger: Logger;
}

/** In-memory counters for I-04; nothing here names a browser, an IP or a hostname. */
export interface BrowserListenerMetrics {
    /** Open connections on the listener, the relay's own included. */
    connections(): number;
    refusals(): Readonly<Record<RefusalReason, number>>;
    traffic(): readonly DailyTraffic[];
    /** Bytes held for browser connections: ClientHellos being read and data in transit either way. */
    bufferedBytes(): number;
}

export interface BrowserListener extends BrowserListenerMetrics {
    /** Resolves with the bound port. */
    listen(port: number, host: string): Promise<number>;
    /** Stops accepting and destroys every connection not handed to the TLS server; resolves once the server closed. */
    close(): Promise<void>;
}

/**
 * The one TCP listener: reads each connection's ClientHello, hands the relay's own hostname to R-03's TLS server, and
 * pipes everything routed to an engine into its tunnel without terminating TLS. A refused connection is destroyed
 * without a single byte written (no TLS alert, no HTTP error), so the relay never acts as a TLS endpoint for an
 * engine's name.
 */
export function createBrowserListener(options: BrowserListenerOptions): BrowserListener {
    const { relayId, engineDomain, sessions, own, limits, clock, logger } = options;
    const ipLimiter = createIpLimiter(limits, clock);
    const engineLimiter = createEngineLimiter(
        {
            maxStreams: limits.maxStreamsPerEngine,
            newStreamsPerS: limits.newStreamsPerEnginePerS,
            bandwidthBytesPerS: limits.engineBandwidthBytesPerS,
        } satisfies EngineLimits,
        clock,
    );
    const refusals = createRefusalCounters();
    const traffic = createTrafficCounters({ clock, retainDays: TRAFFIC_RETAIN_DAYS });
    const schedulers = new WeakMap<TunnelSession, StreamScheduler>();
    /** Connections this listener still owns, with what each holds in memory. */
    const held = new Map<Socket, () => number>();
    const server: Server = createServer(
        { noDelay: true, keepAlive: true, keepAliveInitialDelay: BROWSER_KEEPALIVE_MS },
        (socket) => {
            guarded(socket, () => {
                accept(socket);
            });
        },
    );

    // Exceptions here are bugs; they must not take the relay down with them, and their messages may quote input.
    function guarded(socket: Socket, run: () => void): void {
        try {
            run();
        } catch (error) {
            logger.error('browser.failed', { problem: error instanceof Error ? error.name : 'unknown' });
            socket.destroy();
        }
    }

    function refuse(socket: Socket, reason: RefusalReason): void {
        refusals.count(reason);
        socket.destroy();
    }

    function schedulerFor(session: TunnelSession): StreamScheduler {
        let scheduler = schedulers.get(session);
        if (scheduler === undefined) {
            const { engineId } = session;
            scheduler = createStreamScheduler({
                tunnel: session,
                throttle: (bytes) => engineLimiter.throttle(engineId, bytes),
                clock,
            });
            schedulers.set(session, scheduler);
        }
        return scheduler;
    }

    function accept(socket: Socket): void {
        socket.on('error', () => undefined);
        const ip = clientIp(socket.remoteAddress);
        // No address: the socket closed before it was handed over.
        if (ip === undefined) {
            socket.destroy();
            return;
        }
        const admission = ipLimiter.admit(ip);
        if (admission.kind === 'refused') {
            refuse(socket, admission.reason);
            return;
        }
        const hello = createClientHelloBuffer({ maxBytes: CLIENT_HELLO_MAX_BYTES });
        held.set(socket, () => hello.bytes().length);
        const cancelDeadline = clock.setTimeout(() => {
            refuse(socket, 'timeout');
        }, limits.clientHelloTimeoutMs);
        socket.once('close', () => {
            cancelDeadline();
            held.delete(socket);
            admission.release();
        });
        const onData = (chunk: Buffer): void => {
            guarded(socket, () => {
                const parse = hello.push(chunk);
                if (parse.kind === 'need-more') return;
                cancelDeadline();
                socket.pause();
                socket.off('data', onData);
                route(socket, ip, parse, hello.bytes());
            });
        };
        socket.on('data', onData);
    }

    function route(socket: Socket, ip: string, parse: ClientHelloVerdict, buffered: Uint8Array): void {
        const decision = routeConnection(parse, { relayHostname: relayId, engineDomain, sessions });
        switch (decision.kind) {
            case 'own':
                held.delete(socket);
                // R-03's TLS server reads these bytes back before anything still in the kernel.
                socket.unshift(buffered);
                own.acceptSocket(socket);
                return;
            case 'reject':
                refuse(socket, decision.reason);
                return;
            case 'engine':
                pipeToEngine(socket, ip, decision.session, buffered);
                return;
        }
    }

    function pipeToEngine(socket: Socket, ip: string, session: TunnelSession, buffered: Uint8Array): void {
        const address = parseIpAddress(ip);
        if (address === null) throw new Error('socket address is not an IP address');
        const { engineId } = session;
        const admission = engineLimiter.admitStream(engineId);
        if (admission.kind === 'refused') {
            refuse(socket, admission.reason);
            return;
        }
        let pipe: SocketStreamPipe | null = null;
        try {
            pipe = pipeSocketToStream({
                socket,
                first: buffered,
                open: (handlers) =>
                    session.openStream(
                        { family: address.family, address: address.bytes, port: socket.remotePort ?? 0 },
                        handlers,
                    ),
                scheduler: schedulerFor(session),
                throttle: (bytes) => engineLimiter.throttle(engineId, bytes),
                countTraffic: (direction, bytes) => {
                    traffic.record(engineId, direction, bytes);
                },
                clock,
                onStreamEnd: () => {
                    admission.release();
                },
            });
        } finally {
            // No pipe, whether the tunnel is gone or something threw: the stream slot was never used.
            if (pipe === null) admission.release();
        }
        if (pipe === null) {
            refuse(socket, 'engine-offline');
            return;
        }
        held.set(socket, pipe.bufferedBytes);
    }

    return {
        listen(port, host) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    resolve((server.address() as AddressInfo).port);
                });
            });
        },
        close() {
            const closed = new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            });
            for (const socket of held.keys()) socket.destroy();
            return closed;
        },
        connections: () => ipLimiter.connections(),
        refusals: () => refusals.snapshot(),
        traffic: () => traffic.snapshot(),
        bufferedBytes: () => [...held.values()].reduce((total, bytes) => total + bytes(), 0),
    };
}
