import type { Socket } from 'node:net';
import { Server, createServer } from 'node:net';

import type { CloseCode, StreamId } from '@ptbk/protocol';
import { CLOSE_CODE, TUNNEL_CLOSE_CODE } from '@ptbk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBudget } from '../domain/limits/memory-budget';
import { createSessionTable } from '../domain/tunnel/session-table';
import type { TunnelSession, TunnelStream } from '../domain/tunnel/tunnel-session';
import { captureClientHello, rawClient } from '../testing/client-hello';
import { ENGINE_DOMAIN, createTestEngine } from '../testing/engines';
import { createMemoryMetrics } from '../testing/memory-metrics';
import { RELAY_ID } from '../testing/relay-harness';
import { createFakeClock } from './fake-clock';
import { createMemoryLogger } from './memory-logger';
import type { BrowserListener, BrowserListenerLimits } from './tcp-listener';
import { SERVER_CONNECTIONS_FACTOR, createBrowserListener } from './tcp-listener';

const limits: BrowserListenerLimits = {
    clientHelloTimeoutMs: 5000,
    pressureClientHelloTimeoutMs: 1000,
    maxConnections: 100,
    maxPending: 25,
    reserved: 10,
    maxConnectionsPerIp: 100,
    maxConnectionsPerIpv6Slash56: 100,
    maxConnectionsPerIpv6Slash48: 100,
    newConnectionsPerIpPerS: 100,
    maxStreamsPerEngine: 1,
    newStreamsPerEnginePerS: 100,
    engineBandwidthBytesPerS: 1_000_000,
    firstByteTimeoutMs: 10_000,
    drainTimeoutMs: 30_000,
    endTimeoutMs: 30_000,
};

/** A tunnel stream that accepts its first write (the ClientHello) and throws on the next: a bug in the pipe's path. */
function throwingOnSecondWrite(closes: CloseCode[]): TunnelStream {
    let writes = 0;
    return {
        id: 1 as StreamId,
        write() {
            writes++;
            if (writes > 1) throw new RangeError('bug');
            return true;
        },
        consumed: () => undefined,
        close: (code) => closes.push(code),
        queuedBytes: () => 0,
    };
}

describe('createBrowserListener', () => {
    let listener: BrowserListener | undefined;
    let blocker: Server | undefined;

    afterEach(async () => {
        await listener?.close();
        listener = undefined;
        const taken = blocker;
        blocker = undefined;
        if (taken !== undefined) await new Promise((resolve) => taken.close(resolve));
    });

    /** A listener whose only tunnel opens streams with `openStream`; returns its port and hostname. */
    async function start(openStream: TunnelSession['openStream'], owned: Socket[] = [], port = 0) {
        const engine = await createTestEngine(150);
        const logger = createMemoryLogger();
        const sessions = createSessionTable<TunnelSession>({ logger });
        const tunnelCloses: number[] = [];
        const session = {
            engineId: engine.engineId,
            remoteIp: '198.51.100.1',
            close: (code: number) => tunnelCloses.push(code),
            openStream,
            bufferedBytes: () => 0,
            whenBufferedBelow: () => () => undefined,
        };
        sessions.register(session as unknown as TunnelSession, [engine.defaultHostname]);
        const created = createBrowserListener({
            relayId: RELAY_ID,
            engineDomain: ENGINE_DOMAIN,
            sessions,
            own: { acceptSocket: (socket) => owned.push(socket) },
            limits,
            clock: createFakeClock(),
            logger,
            memory: createMemoryBudget(1_048_576),
            metrics: createMemoryMetrics(),
        });
        listener = created;
        return {
            port: await created.listen(port, '127.0.0.1'),
            logger,
            hostname: engine.defaultHostname,
            listener: created,
            tunnelCloses,
        };
    }

    it('refuses as engine-offline when the tunnel is gone by the time the stream would open, freeing the slot', async () => {
        const { port, hostname, listener: created } = await start(() => null);
        const hello = await captureClientHello(hostname);
        for (let attempt = 0; attempt < 2; attempt++) {
            const client = rawClient(port);
            client.socket.write(hello);
            expect(await client.closed).toHaveLength(0);
        }
        // Both reached OPEN: the first released its stream slot (the cap is 1).
        expect(created.refusals()['engine-offline']).toBe(2);
    });

    it('drops a connection whose handling fails and closes its tunnel, logging only the error name', async () => {
        let thrown: unknown = new RangeError(`detail that may quote input`);
        const { port, hostname, logger, tunnelCloses } = await start(() => {
            throw thrown;
        });
        const hello = await captureClientHello(hostname);
        const first = rawClient(port);
        first.socket.write(hello);
        expect(await first.closed).toHaveLength(0);
        thrown = 'not an Error';
        const second = rawClient(port);
        second.socket.write(hello);
        expect(await second.closed).toHaveLength(0);
        expect(logger.entries).toEqual([
            { level: 'error', event: 'browser.failed', fields: { problem: 'RangeError' } },
            { level: 'error', event: 'browser.failed', fields: { problem: 'unknown' } },
        ]);
        expect(tunnelCloses).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR, TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
    });

    it('resets the stream and closes only its tunnel when a pipe handler throws', async () => {
        const streamCloses: CloseCode[] = [];
        const {
            port,
            hostname,
            logger,
            tunnelCloses,
            listener: created,
        } = await start(() => throwingOnSecondWrite(streamCloses));
        const client = rawClient(port);
        client.socket.write(await captureClientHello(hostname));
        await vi.waitFor(() => {
            expect(created.connections()).toBe(1);
            expect(created.pendingConnections()).toBe(0);
        });
        client.socket.write('more');
        expect(await client.closed).toHaveLength(0);
        expect(streamCloses).toEqual([CLOSE_CODE.RESET]);
        expect(tunnelCloses).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(created.resets().failed).toBe(1);
        expect(logger.entries).toEqual([
            { level: 'error', event: 'browser.failed', fields: { problem: 'RangeError' } },
        ]);
        await vi.waitFor(() => {
            expect(created.connections()).toBe(0);
        });
    });

    it('caps its connections above the admission limit and survives accept errors', async () => {
        const listen = vi.spyOn(Server.prototype, 'listen');
        const { logger } = await start(() => null);
        const server = listen.mock.contexts[0] as Server;
        listen.mockRestore();
        expect(server.maxConnections).toBe(limits.maxConnections * SERVER_CONNECTIONS_FACTOR);
        server.emit('error', Object.assign(new Error('accept failed'), { code: 'EMFILE' }));
        expect(logger.entries).toEqual([
            { level: 'error', event: 'relay.accept-failed', fields: { problem: 'Error' } },
        ]);
    });

    it('hands the relay hostname to the TLS server with the bytes it read put back', async () => {
        const owned: Socket[] = [];
        const { port } = await start(() => null, owned);
        const hello = await captureClientHello(RELAY_ID);
        const client = rawClient(port);
        client.socket.write(Buffer.concat([hello, Buffer.from('more')]));
        await vi.waitFor(() => {
            expect(owned).toHaveLength(1);
        });
        const socket = owned[0] as Socket;
        const replayed: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => replayed.push(chunk));
        socket.resume();
        await vi.waitFor(() => {
            expect(Buffer.concat(replayed)).toEqual(Buffer.concat([hello, Buffer.from('more')]));
        });
        socket.destroy();
    });

    it('rejects listen when the port is taken', async () => {
        const taken = createServer();
        blocker = taken;
        await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
        const address = taken.address();
        if (address === null || typeof address === 'string') throw new Error('no port');
        await expect(start(() => null, [], address.port)).rejects.toThrow('EADDRINUSE');
    });
});
