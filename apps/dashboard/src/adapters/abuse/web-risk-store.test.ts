import { describe, expect, it } from 'vitest';

import { CHUNK_BYTES, createMemoryWebRiskStorage, createWebRiskStore, type ThreatListUpdate } from './web-risk-store';

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** `count` distinct 4-byte prefixes, ascending: 0, 1, 2, … as big-endian integers. */
function ascending(count: number, start = 0): Uint8Array {
    const bytes = new Uint8Array(count * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < count; index++) view.setUint32(index * 4, start + index);
    return bytes;
}

async function reset(hashes: Uint8Array, versionToken = 'AQ=='): Promise<ThreatListUpdate> {
    return {
        kind: 'reset',
        additions: [{ prefixSize: 4, hashes }],
        removals: [],
        checksum: await sha256(hashes),
        versionToken,
        nextDiffAt: 1000,
    };
}

const fullHash = (prefix: Uint8Array) => {
    const hash = new Uint8Array(32).fill(0xaa);
    hash.set(prefix);
    return hash;
};

describe('createWebRiskStore', () => {
    it('keeps a list larger than one storage value across chunks, and reads it back in a new instance', async () => {
        const storage = createMemoryWebRiskStorage();
        const hashes = ascending(300_000);
        expect(await createWebRiskStore(storage).apply('MALWARE', await reset(hashes), 5)).toBe(true);
        expect([...storage.entries.keys()].filter((key) => key.startsWith('chunk:MALWARE:'))).toHaveLength(
            Math.ceil((hashes.length + 6) / CHUNK_BYTES),
        );
        const reopened = createWebRiskStore(storage);
        expect(await reopened.versions()).toEqual({
            MALWARE: { versionToken: 'AQ==', nextDiffAt: 1000, updatedAt: 5 },
        });
        const hits = await reopened.prefixHits([
            fullHash(hashes.subarray(4 * 299_999, 4 * 300_000)),
            new Uint8Array(32).fill(0xff),
        ]);
        expect(hits).toEqual([[hashes.subarray(4 * 299_999, 4 * 300_000)], []]);
    });

    it('deletes chunks a shorter list no longer needs', async () => {
        const storage = createMemoryWebRiskStorage();
        const store = createWebRiskStore(storage);
        await store.apply('MALWARE', await reset(ascending(300_000)), 1);
        const small = ascending(2);
        await store.apply('MALWARE', await reset(small, 'Ag=='), 2);
        expect([...storage.entries.keys()].filter((key) => key.startsWith('chunk:'))).toEqual(['chunk:MALWARE:0']);
        expect(await createWebRiskStore(storage).prefixHits([fullHash(small.subarray(4, 8))])).toEqual([
            [small.subarray(4, 8)],
        ]);
    });

    it('drops a list an update does not fit, so the next diff is a reset', async () => {
        const storage = createMemoryWebRiskStorage();
        const store = createWebRiskStore(storage);
        await store.apply('SOCIAL_ENGINEERING', await reset(ascending(4)), 1);
        const wrong = { ...(await reset(ascending(4))), kind: 'diff' as const, checksum: new Uint8Array(32) };
        expect(await store.apply('SOCIAL_ENGINEERING', wrong, 2)).toBe(false);
        expect(await store.versions()).toEqual({});
        expect(storage.entries.size).toBe(0);
        expect(await store.apply('MALWARE', wrong, 3)).toBe(false);
    });

    it.each([
        ['a meta it cannot read', (entries: Map<string, unknown>) => entries.set('meta:MALWARE', { v: 99 })],
        ['a missing chunk', (entries: Map<string, unknown>) => entries.delete('chunk:MALWARE:0')],
        [
            'a chunk it did not write',
            (entries: Map<string, unknown>) => entries.set('chunk:MALWARE:0', Uint8Array.from([7])),
        ],
    ])('starts a list over from %s', async (_, damage) => {
        const storage = createMemoryWebRiskStorage();
        await createWebRiskStore(storage).apply('MALWARE', await reset(ascending(4)), 1);
        damage(storage.entries);
        const reopened = createWebRiskStore(storage);
        expect(await reopened.versions()).toEqual({});
        expect(await reopened.prefixHits([fullHash(ascending(1))])).toEqual([[]]);
    });

    it('reports a prefix in two lists once', async () => {
        const store = createWebRiskStore(createMemoryWebRiskStorage());
        await store.apply('MALWARE', await reset(ascending(1)), 1);
        await store.apply('UNWANTED_SOFTWARE', await reset(ascending(1)), 1);
        expect(await store.prefixHits([fullHash(ascending(1))])).toEqual([[ascending(1)]]);
    });

    it('keeps hashes.search answers until they expire, replacing a prefix answer, and forgets the expired', async () => {
        const storage = createMemoryWebRiskStorage();
        const store = createWebRiskStore(storage);
        const [a, b] = [Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 6, 7, 8])];
        const threat = { hash: fullHash(a), until: 50 };
        await store.cacheSearches([{ prefix: a, result: { threats: [threat], negativeUntil: 10 } }], 0);
        await store.cacheSearches([{ prefix: b, result: { threats: [], negativeUntil: 100 } }], 0);
        expect(await createWebRiskStore(storage).cachedSearches([a, b, Uint8Array.from([9, 9, 9, 9])])).toEqual([
            { threats: [threat], negativeUntil: 10 },
            { threats: [], negativeUntil: 100 },
            null,
        ]);
        await store.cacheSearches([{ prefix: b, result: { threats: [], negativeUntil: 200 } }], 60);
        expect(await store.cachedSearches([a, b])).toEqual([null, { threats: [], negativeUntil: 200 }]);
        storage.entries.set('search:00', { v: 2 });
        await store.cacheSearches([], 61);
        expect([...storage.entries.keys()]).toEqual(['search:05060708']);
    });
});
