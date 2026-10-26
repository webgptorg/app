import { createServer } from 'node:net';
import { connect } from 'node:net';

import { describe, expect, it } from 'vitest';

import { freeLoopbackPort, listenLoopback } from './loopback';

function reachable(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => {
            resolve(false);
        });
    });
}

/** A server whose IPv6 listen fails with `code`, `times` times; IPv4 listens normally. */
function failingV6(code: string, times = Infinity) {
    let failures = 0;
    return () => {
        const server = createServer();
        const listen = server.listen.bind(server);
        server.listen = ((options: { host?: string }) => {
            if (options.host === '::1' && failures < times) {
                failures++;
                setImmediate(() => server.emit('error', Object.assign(new Error(code), { code })));
                return server;
            }
            return listen(options);
        }) as typeof server.listen;
        return server;
    };
}

describe('listenLoopback', () => {
    it('falls back to IPv4 only where the host has no IPv6 loopback', async () => {
        const listener = await listenLoopback(failingV6('EADDRNOTAVAIL'));
        expect(await reachable('127.0.0.1', listener.port)).toBe(true);
        await listener.close();
    });

    it('tries another port when the IPv6 one is taken, and gives up eventually', async () => {
        const listener = await listenLoopback(failingV6('EADDRINUSE', 2));
        expect(await reachable('127.0.0.1', listener.port)).toBe(true);
        await listener.close();
        await expect(listenLoopback(failingV6('EADDRINUSE'))).rejects.toThrow(/no loopback port/);
    });

    it('passes on any other listen error', async () => {
        await expect(listenLoopback(failingV6('EACCES'))).rejects.toThrow('EACCES');
    });

    it('listens on both loopback addresses on one port', async () => {
        const listener = await listenLoopback(() => createServer((socket) => socket.end()));
        expect(await reachable('127.0.0.1', listener.port)).toBe(true);
        expect(await reachable('localhost', listener.port)).toBe(true);
        await listener.close();
        expect(await reachable('127.0.0.1', listener.port)).toBe(false);
    });

    it('hands out a port that is free', async () => {
        const port = await freeLoopbackPort();
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
        server.close();
    });
});
