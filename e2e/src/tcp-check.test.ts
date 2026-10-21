import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { LISTENER_BANNER, listen, tcpAttempt } from './tcp-check.ts';

const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function portOf(server: Server): number {
    return (server.address() as AddressInfo).port;
}

describe('tcpAttempt', () => {
    it('reads the banner of the listener', async () => {
        const [server] = await listen([0], 'engine-host');
        if (server === undefined) throw new Error('no listener');
        servers.push(server);
        const attempt = await tcpAttempt('127.0.0.1', portOf(server), 2_000);
        expect(attempt.outcome).toBe('connected');
        expect(attempt.banner).toBe(`${LISTENER_BANNER} engine-host:0\n`);
    });

    it('counts a connection that stays silent as connected', async () => {
        const server = createServer(() => undefined);
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const attempt = await tcpAttempt('127.0.0.1', portOf(server), 200);
        expect(attempt).toMatchObject({ outcome: 'connected', banner: '' });
    });

    it('reports a closed port as refused', async () => {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = portOf(server);
        await new Promise((resolve) => server.close(resolve));
        expect((await tcpAttempt('127.0.0.1', port, 2_000)).outcome).toBe('refused');
    });
});
