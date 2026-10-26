import * as http from 'node:http';

import { describe, expect, it } from 'vitest';

import { startConnectProxy } from './connect-proxy';

function connect(url: string, target: string, auth: string | null): Promise<number> {
    const proxy = new URL(url);
    return new Promise((resolve, reject) => {
        const outgoing = http.request({
            host: proxy.hostname,
            port: Number(proxy.port),
            method: 'CONNECT',
            path: target,
            headers: auth === null ? {} : { 'Proxy-Authorization': `Basic ${Buffer.from(auth).toString('base64')}` },
        });
        outgoing.once('connect', (response, socket) => {
            socket.destroy();
            resolve(response.statusCode ?? 0);
        });
        outgoing.once('response', (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
        });
        outgoing.once('error', reject);
        outgoing.end();
    });
}

describe('the CONNECT proxy', () => {
    it('asks for credentials, refuses other targets and is not a web proxy', async () => {
        const proxy = await startConnectProxy({
            allowedTargets: ['relay.localhost:1'],
            upstreamHost: '127.0.0.1',
            credentials: { username: 'u', password: 'p' },
        });
        try {
            expect(await connect(proxy.url, 'relay.localhost:1', null)).toBe(407);
            expect(await connect(proxy.url, 'elsewhere.localhost:1', 'u:p')).toBe(403);
            expect(proxy.requests.map(({ status, authorized }) => [status, authorized])).toEqual([
                [407, false],
                [403, true],
            ]);
            const plain = await fetch(new URL('/', proxy.url.replace('u:p@', '')));
            expect(plain.status).toBe(405);
        } finally {
            await proxy.close();
        }
    });
});
