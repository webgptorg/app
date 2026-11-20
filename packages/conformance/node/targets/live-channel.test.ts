import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { createLiveChannelOpener } from './live-channel';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0)) await close();
});

/** A plain WebSocket server standing in for the engine: the opener only needs a connected duplex. */
async function engine() {
    const seen: IncomingMessage[] = [];
    const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false });
    const server = createServer();
    server.on('upgrade', (request: IncomingMessage, socket, head) => {
        seen.push(request);
        if (request.headers.cookie === 'drop') {
            socket.destroy();
            return;
        }
        if (request.headers.cookie === undefined) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.on('message', (data, isBinary) => {
                ws.send(data, { binary: isBinary });
                if (!isBinary && Buffer.from(data as Buffer).toString('utf8') === 'bye') ws.close(4000);
            });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    closers.push(
        () =>
            new Promise((resolve) => {
                for (const client of wss.clients) client.terminate();
                server.close(() => {
                    resolve();
                });
            }),
    );
    const open = createLiveChannelOpener(
        new URL('https://e.engine.localhost'),
        () =>
            new Promise((resolve) => {
                const socket = connect(port, '127.0.0.1', () => {
                    resolve(socket);
                });
            }),
        5_000,
    );
    return { seen, open };
}

describe('createLiveChannelOpener', () => {
    it('opens the session’s channel with the subprotocol, cookie and origin, and relays both ways', async () => {
        const { seen, open } = await engine();
        const opened = await open('session-1', { cookie: 'a=b' }, 'https://e.engine.localhost');
        if (opened.kind !== 'open') throw new Error('refused');
        const [request] = seen;
        expect(request?.url).toBe('/api/v1/live-sessions/session-1/channel');
        expect(request?.headers).toMatchObject({
            cookie: 'a=b',
            origin: 'https://e.engine.localhost',
            host: 'e.engine.localhost',
            'sec-websocket-protocol': 'ptbk-live',
        });
        const { channel } = opened;
        channel.send('hi');
        expect(await channel.next(5_000)).toEqual({ kind: 'text', text: 'hi' });
        channel.send(Uint8Array.of(1, 2));
        const binary = await channel.next(5_000);
        expect(binary?.kind === 'binary' && [...binary.bytes]).toEqual([1, 2]);
        channel.send('bye');
        expect(await channel.next(5_000)).toEqual({ kind: 'text', text: 'bye' });
        expect(await channel.next(5_000)).toEqual({ kind: 'closed', code: 4000 });
    });

    it('answers a refused upgrade with its status, and sends a bearer token as such', async () => {
        const { seen, open } = await engine();
        expect(await open('session-1', null, 'https://evil.example')).toEqual({ kind: 'refused', status: 401 });
        expect(seen[0]?.headers.origin).toBe('https://evil.example');
        expect(await open('session-1', { bearer: 'token' }, 'https://e.engine.localhost')).toEqual({
            kind: 'refused',
            status: 401,
        });
        expect(seen[1]?.headers.authorization).toBe('Bearer token');
    });

    it('fails when the connection drops before the engine answers', async () => {
        const { open } = await engine();
        await expect(open('session-1', { cookie: 'drop' }, 'https://e.engine.localhost')).rejects.toThrow();
    });

    it('closes the channel when the test does', async () => {
        const { open } = await engine();
        const opened = await open('session-1', { cookie: 'a=b' }, 'https://e.engine.localhost');
        if (opened.kind !== 'open') throw new Error('refused');
        opened.channel.close();
        expect(await opened.channel.next(1_000)).toEqual({ kind: 'closed', code: 1000 });
    });
});
