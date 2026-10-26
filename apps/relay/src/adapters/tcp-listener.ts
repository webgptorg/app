import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer } from 'node:net';

import type { Hostname, RelayId } from '@ptbk/protocol';
import { TUNNEL_CLOSE_CODE, createClientHelloBuffer } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import { parseIpAddress } from '../domain/ip-address';
import type { ConnectionPoolLimits } from '../domain/limits/connection-pool';
import { createConnectionPool } from '../domain/limits/connection-pool';
import type { EngineLimits } from '../domain/limits/engine-limiter';
import { createEngineLimiter } from '../domain/limits/engine-limiter';
import type { IpLimits } from '../domain/limits/ip-limiter';
import { createIpLimiter } from '../domain/limits/ip-limiter';
import type { MemoryBudget } from '../domain/limits/memory-budget';
import { createMemoryCharge } from '../domain/limits/memory-budget';
import type { Logger } from '../domain/logger';
import type { Metrics } from '../domain/metrics/catalog';
import { refusalOutcome } from '../domain/metrics/catalog';
import type { RefusalReason, StreamResetReason } from '../domain/metrics/reason-counters';
import { REFUSAL_REASONS, STREAM_RESET_REASONS, createReasonCounters } from '../domain/metrics/reason-counters';
import type { DailyTraffic } from '../domain/metrics/traffic-counters';
import { createTrafficCounters } from '../domain/metrics/traffic-counters';
import { routeConnection } from '../domain/routing/route-connection';
import type { StreamScheduler } from '../domain/routing/stream-scheduler';
import { createStreamScheduler } from '../domain/routing/stream-scheduler';
import type { SessionTable } from '../domain/tunnel/session-table';
import type { TunnelSession } from '../domain/tunnel/tunnel-session';
import type { OwnTlsServer } from './own-tls-server';
import { clientIp } from './own-tls-server';
import type { SocketStreamPipe, StreamLimits } from './socket-stream-pipe';
import { STREAM_RESERVE_BYTES, pipeSocketToStream } from './socket-stream-pipe';

/** The ClientHello handshake message across its records, headers excluded; room for post-quantum key shares. */
export const CLIENT_HELLO_MAX_HELLO_BYTES = 32 * 1024;
/**
 * Everything read before a verdict, record headers included: the hello plus headers for 64 records. Browsers split a
 * ClientHello only at the 16 KiB record limit, so only a client padding it with tiny records reaches this first.
 */
export const CLIENT_HELLO_MAX_BYTES = CLIENT_HELLO_MAX_HELLO_BYTES + 64 * 5;
/** Browsers send a ClientHello in one to three chunks; a client trickling it in more is refused as `malformed`. */
export const CLIENT_HELLO_MAX_CHUNKS = 64;
/** Streams have no idle timeout (SSE and WebSockets live long); keepalive finds browsers that vanished. */
export const BROWSER_KEEPALIVE_MS = 60_000;
/**
 * Node's own cap, as a multiple of `maxConnections`: a backstop against a counting bug only. Refused and evicted
 * sockets stay in Node's count until their close event, so a cap at `maxConnections` would drop new connections
 * before the pool could evict for them.
 */
export const SERVER_CONNECTIONS_FACTOR = 2;
/**
 * Today only: per-engine byte counts live in this process's memory alone, never logged or exported, and a day's totals
 * are dropped at UTC midnight (spec, Metadata we still see: at most 24 h). `/metrics` carries only the aggregate.
 */
const TRAFFIC_RETAIN_DAYS = 1;

export interface BrowserListenerLimits extends IpLimits, ConnectionPoolLimits, StreamLimits {
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
    /** ClientHello deadlines, the token buckets, and accept times; the tunnel endpoint's clock. */
    readonly clock: Clock;
    readonly logger: Logger;
    /** The relay-wide budget; ClientHellos being read and data in transit count against it. */
    readonly memory: MemoryBudget;
    /** Outcomes, aggregate bytes and stream-open latency; never which browser, engine or hostname. */
    readonly metrics: Metrics;
}

/** In-memory counters for I-04; nothing here names a browser, an IP or a hostname. */
export interface BrowserListenerMetrics {
    /** Open connections on the listener, the relay's own included. */
    connections(): number;
    /** Of those, connections whose ClientHello is not judged yet. */
    pendingConnections(): number;
    refusals(): Readonly<Record<RefusalReason, number>>;
    /** Streams the relay reset on its own: deadlines and failures. */
    resets(): Readonly<Record<StreamResetReason, number>>;
    traffic(): readonly DailyTraffic[];
    /** Bytes held for browser connections: ClientHellos being read and data in transit either way. */
    bufferedBytes(): number;
}

export interface BrowserListener extends BrowserListenerMetrics {
    /** Resolves with the bound port. */
    listen(port: number, host: string, backlog: number): Promise<number>;
    /** Stops accepting and destroys every connection not handed to the TLS server; resolves once the server closed. */
    close(): Promise<void>;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/**
 * The one TCP listener: reads each connection's ClientHello, hands the relay's own hostname to R-03's TLS server, and
 * pipes everything routed to an engine into its tunnel without terminating TLS. A refused connection is destroyed
 * without a single byte written (no TLS alert, no HTTP error), so the relay never acts as a TLS endpoint for an
 * engine's name. A connection holds its admission until nothing is held for it any more: until its socket closed and,
 * once piped, its stream ended too.
 */
export function createBrowserListener(options: BrowserListenerOptions): BrowserListener {
    const { relayId, engineDomain, sessions, own, limits, clock, logger, memory, metrics } = options;
    const ipLimiter = createIpLimiter(limits, clock);
    const pool = createConnectionPool(limits, clock);
    const engineLimiter = createEngineLimiter(
        {
            maxStreams: limits.maxStreamsPerEngine,
            newStreamsPerS: limits.newStreamsPerEnginePerS,
            bandwidthBytesPerS: limits.engineBandwidthBytesPerS,
        } satisfies EngineLimits,
        clock,
    );
    const refusals = createReasonCounters(REFUSAL_REASONS);
    const resets = createReasonCounters(STREAM_RESET_REASONS);
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
    server.maxConnections = limits.maxConnections * SERVER_CONNECTIONS_FACTOR;

    // Exceptions here are bugs; they must not take the relay down with them, and their messages may quote input.
    function guarded(socket: Socket, run: () => void): void {
        try {
            run();
        } catch (error) {
            logger.error('browser.failed', { problem: errorName(error) });
            socket.destroy();
        }
    }

    // A bug in a stream's handlers leaves its tunnel's flow control in an unknown state: the tunnel goes too.
    function tunnelFailed(session: TunnelSession, error: unknown): void {
        logger.error('browser.failed', { problem: errorName(error) });
        session.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
    }

    function refuse(socket: Socket, reason: RefusalReason): void {
        refusals.count(reason);
        metrics.count('ptbk_relay_browser_connections_total', { outcome: refusalOutcome(reason) });
        socket.destroy();
    }

    function schedulerFor(session: TunnelSession): StreamScheduler {
        let scheduler = schedulers.get(session);
        if (scheduler === undefined) {
            const { engineId } = session;
            scheduler = createStreamScheduler({
                tunnel: session,
                throttle: (bytes) => engineLimiter.throttle(engineId, bytes),
                clock: {
                    nowMs: () => clock.nowMs(),
                    setTimeout: (run, ms) =>
                        clock.setTimeout(() => {
                            try {
                                run();
                            } catch (error) {
                                tunnelFailed(session, error);
                            }
                        }, ms),
                },
            });
            schedulers.set(session, scheduler);
        }
        return scheduler;
    }

    function accept(socket: Socket): void {
        const acceptedAtMs = clock.nowMs();
        socket.on('error', () => undefined);
        const ip = clientIp(socket.remoteAddress);
        // No address: the socket closed before it was handed over.
        if (ip === undefined) {
            socket.destroy();
            return;
        }
        const ipAdmission = ipLimiter.admit(ip);
        if (ipAdmission.kind === 'refused') {
            refuse(socket, ipAdmission.reason);
            return;
        }
        const pooled = pool.admit((reason) => {
            refuse(socket, reason);
        });
        if (pooled.kind === 'refused') {
            ipAdmission.release();
            refuse(socket, pooled.reason);
            return;
        }
        const { connection } = pooled;
        const release = (): void => {
            held.delete(socket);
            connection.release();
            ipAdmission.release();
        };
        const hello = createClientHelloBuffer({
            maxBytes: CLIENT_HELLO_MAX_BYTES,
            maxHelloBytes: CLIENT_HELLO_MAX_HELLO_BYTES,
            maxChunks: CLIENT_HELLO_MAX_CHUNKS,
        });
        const helloCharge = createMemoryCharge(memory);
        held.set(socket, () => hello.bytes().length);
        let piped = false;
        socket.once('close', () => {
            helloCharge.set(0);
            if (!piped) release();
        });
        const onData = (chunk: Buffer): void => {
            guarded(socket, () => {
                const parse = hello.push(chunk);
                helloCharge.set(hello.bytes().length);
                if (parse.kind === 'need-more') return;
                const judgedAtMs = clock.nowMs();
                socket.pause();
                socket.off('data', onData);
                helloCharge.set(0);
                const decision = routeConnection(parse, { relayHostname: relayId, engineDomain, sessions });
                switch (decision.kind) {
                    case 'own':
                        connection.route('own');
                        metrics.count('ptbk_relay_browser_connections_total', { outcome: 'own-hostname' });
                        held.delete(socket);
                        // R-03's TLS server reads these bytes back before anything still in the kernel.
                        socket.unshift(hello.bytes());
                        // R-03's handshake deadline counts from TCP accept, so a slow ClientHello spends it too.
                        own.acceptSocket(socket, acceptedAtMs);
                        return;
                    case 'reject':
                        refuse(socket, decision.reason);
                        return;
                    case 'engine':
                        if (!memory.hasRoomFor(STREAM_RESERVE_BYTES)) {
                            refuse(socket, 'memory-limit');
                            return;
                        }
                        if (!connection.route('engine')) {
                            refuse(socket, 'global-limit');
                            return;
                        }
                        piped = pipeToEngine(socket, ip, decision.session, hello.bytes(), release, judgedAtMs);
                        return;
                }
            });
        };
        socket.on('data', onData);
    }

    /** `false`: refused, and the socket's close releases it as usual. */
    function pipeToEngine(
        socket: Socket,
        ip: string,
        session: TunnelSession,
        buffered: Uint8Array,
        release: () => void,
        helloAtMs: number,
    ): boolean {
        const address = parseIpAddress(ip);
        if (address === null) throw new Error('socket address is not an IP address');
        const { engineId } = session;
        const admission = engineLimiter.admitStream(engineId);
        if (admission.kind === 'refused') {
            refuse(socket, admission.reason);
            return false;
        }
        let answered = false;
        let pipe: SocketStreamPipe | null;
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
                    metrics.count('ptbk_relay_bytes_total', { direction }, bytes);
                    if (direction === 'out' && !answered) {
                        answered = true;
                        metrics.observe('ptbk_relay_stream_open_seconds', {}, (clock.nowMs() - helloAtMs) / 1000);
                    }
                },
                clock,
                limits,
                memory,
                countReset: (reason) => {
                    resets.count(reason);
                },
                onStreamEnd: () => {
                    admission.release();
                },
                onDone: release,
                onFailure: (error) => {
                    tunnelFailed(session, error);
                },
            });
        } catch (error) {
            // The stream may already be open, so its tunnel is in an unknown state too.
            admission.release();
            socket.destroy();
            tunnelFailed(session, error);
            return false;
        }
        if (pipe === null) {
            admission.release();
            refuse(socket, 'engine-offline');
            return false;
        }
        held.set(socket, pipe.bufferedBytes);
        metrics.count('ptbk_relay_browser_connections_total', { outcome: 'routed' });
        return true;
    }

    return {
        listen(port, host, backlog) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen({ port, host, backlog }, () => {
                    server.off('error', reject);
                    // Accept errors (EMFILE) are emitted here; without a listener they would end the process.
                    server.on('error', (error: Error) => {
                        logger.error('relay.accept-failed', { problem: error.name });
                    });
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
        connections: () => pool.connections(),
        pendingConnections: () => pool.pending(),
        refusals: () => refusals.snapshot(),
        resets: () => resets.snapshot(),
        traffic: () => traffic.snapshot(),
        bufferedBytes: () => [...held.values()].reduce((total, bytes) => total + bytes(), 0),
    };
}
