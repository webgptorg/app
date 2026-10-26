import { request } from 'node:https';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestCa } from '../../pki/test-ca';
import type { StoreServer } from './store-server';
import { openStoreServer } from './store-server';

const ca = createTestCa('store test CA', { permittedDomains: ['localhost'] });

interface Answer {
    readonly status: number;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: Buffer;
    /** Set when the connection ended before the announced body arrived. */
    readonly aborted: boolean;
}

/** A request as the engine makes it: by the store's name, trusting only the run's CA. */
function get(url: URL, method = 'GET'): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const outgoing = request(url, { method, ca: ca.certPem, agent: false }, (incoming) => {
            const chunks: Buffer[] = [];
            let aborted = false;
            incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
            incoming.on('aborted', () => {
                aborted = true;
            });
            incoming.on('error', () => {
                aborted = true;
            });
            incoming.on('close', () => {
                resolve({
                    status: incoming.statusCode ?? 0,
                    headers: incoming.headers,
                    body: Buffer.concat(chunks),
                    aborted: aborted || !incoming.complete,
                });
            });
        });
        outgoing.on('error', reject);
        outgoing.end();
    });
}

describe('the fake release store over HTTPS', () => {
    let store: StoreServer;
    beforeEach(async () => {
        store = await openStoreServer({ hostname: 'ui-store.localhost', ...ca.issue(['ui-store.localhost']) });
    });
    afterEach(async () => {
        await store.close();
    });

    it('serves exactly what was put, under an https base URL ending in /', async () => {
        expect(store.url.protocol).toBe('https:');
        expect(store.url.hostname).toBe('ui-store.localhost');
        expect(store.url.pathname.endsWith('/')).toBe(true);
        store.put('ui/latest.json', JSON.stringify({ version: '1.0.1' }));
        store.put('ui/1.0.1/ui%2Bbundle.tar.zst', Uint8Array.of(1, 2, 3));

        const latest = await get(new URL('ui/latest.json', store.url));
        expect(latest.status).toBe(200);
        expect(latest.headers['content-type']).toBe('application/json');
        expect(JSON.parse(latest.body.toString('utf8'))).toEqual({ version: '1.0.1' });

        const artifact = await get(new URL('ui/1.0.1/ui%2Bbundle.tar.zst', store.url));
        expect(artifact.headers['content-type']).toBe('application/octet-stream');
        expect([...artifact.body]).toEqual([1, 2, 3]);

        expect((await get(new URL('ui/1.0.2/other.tar.zst', store.url))).status).toBe(404);
        const head = await get(new URL('ui/latest.json', store.url), 'HEAD');
        expect(head.status).toBe(200);
        expect(head.headers['content-length']).toBe(String(latest.body.length));
        expect(head.body.length).toBe(0);
    });

    it('records every request under the base path, still encoded, before answering', async () => {
        const before = Date.now();
        await get(new URL('release-log/ui-1.0.1.json', store.url));
        await get(new URL('ui/1.0.1/a%20b.tar.zst?x=1', store.url));
        await get(new URL('/elsewhere', store.url));
        expect((await get(new URL('ui/latest.json', store.url), 'POST')).status).toBe(404);
        expect(store.requests().map((entry) => entry.path)).toEqual([
            'release-log/ui-1.0.1.json',
            'ui/1.0.1/a%20b.tar.zst',
        ]);
        for (const entry of store.requests()) expect(entry.atMs).toBeGreaterThanOrEqual(before);
    });

    it('answers a path with a fault until the fault is cleared, and forgets deleted paths', async () => {
        const path = 'release-log/revocations.json';
        store.put(path, '{"payload":"x"}');
        store.fault(path, 'error');
        expect((await get(new URL(path, store.url))).status).toBe(503);
        store.fault(path, null);
        expect((await get(new URL(path, store.url))).status).toBe(200);
        store.delete(path);
        expect((await get(new URL(path, store.url))).status).toBe(404);
        expect(store.requests()).toHaveLength(3);
    });

    it('cuts a truncated body off after the headers announced all of it', async () => {
        const body = new Uint8Array(64 * 1024).fill(7);
        store.put('ui/1.0.1/ui.tar.zst', body);
        store.fault('ui/1.0.1/ui.tar.zst', 'truncate');
        const answer = await get(new URL('ui/1.0.1/ui.tar.zst', store.url));
        expect(answer.status).toBe(200);
        expect(answer.headers['content-length']).toBe(String(body.length));
        expect(answer.aborted).toBe(true);
        expect(answer.body.length).toBeLessThan(body.length);
    });
});
