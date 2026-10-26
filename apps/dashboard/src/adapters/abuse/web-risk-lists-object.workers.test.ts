import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createDurableObjectWebRiskStore, WEB_RISK_LISTS_NAME } from './durable-object-web-risk-store';

/** 300,000 ascending 4-byte prefixes: more than one Durable Object value holds. */
function ascending(count: number): Uint8Array {
    const bytes = new Uint8Array(count * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < count; index++) view.setUint32(index * 4, index * 7);
    return bytes;
}

describe('WebRiskLists', () => {
    it('keeps a multi-megabyte list in its storage and answers prefix hits and cached searches over RPC', async () => {
        const store = createDurableObjectWebRiskStore(env.WEB_RISK_LISTS);
        const hashes = ascending(300_000);
        const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', hashes));
        const update = {
            kind: 'reset' as const,
            additions: [{ prefixSize: 4, hashes }],
            removals: [],
            checksum,
            versionToken: 'AQ==',
            nextDiffAt: 2000,
        };
        expect(await store.apply('MALWARE', update, 1000)).toBe(true);
        expect(await store.versions()).toEqual({
            MALWARE: { versionToken: 'AQ==', nextDiffAt: 2000, updatedAt: 1000 },
        });
        const hit = new Uint8Array(32);
        hit.set(hashes.subarray(4 * 123_456, 4 * 123_457));
        expect(await store.prefixHits([hit, new Uint8Array(32).fill(0xff)])).toEqual([
            [hashes.subarray(4 * 123_456, 4 * 123_457)],
            [],
        ]);
        const prefix = hit.subarray(0, 4);
        await store.cacheSearches(
            [{ prefix, result: { threats: [{ hash: hit, until: 5000 }], negativeUntil: 4000 } }],
            1000,
        );
        expect(await store.cachedSearches([prefix])).toEqual([
            { threats: [{ hash: hit, until: 5000 }], negativeUntil: 4000 },
        ]);
        const stub = env.WEB_RISK_LISTS.get(env.WEB_RISK_LISTS.idFromName(WEB_RISK_LISTS_NAME));
        await runInDurableObject(stub, async (_, state) => {
            const keys = [...(await state.storage.list()).keys()];
            expect(keys.filter((key) => key.startsWith('chunk:MALWARE:'))).toHaveLength(2);
            expect(keys).toContain('meta:MALWARE');
        });
    });
});
