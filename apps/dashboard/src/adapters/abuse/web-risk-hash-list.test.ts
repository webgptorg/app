import { describe, expect, it } from 'vitest';

import {
    EMPTY_HASH_LIST,
    applyHashListUpdate,
    decodeHashList,
    encodeHashList,
    hashListSize,
    matchingPrefixes,
    type HashListUpdate,
    type HashPrefixList,
} from './web-risk-hash-list';

const bytes = (...values: number[]) => Uint8Array.from(values);
const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};
async function checksum(...sorted: Uint8Array[]): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...sorted)));
}

const A = bytes(0x00, 0x00, 0x00, 0x01);
const B = bytes(0x10, 0x20, 0x30, 0x40);
/** Starts with B, so it sorts right after it. */
const B_LONG = bytes(0x10, 0x20, 0x30, 0x40, 0x00);
const C = bytes(0x80, 0x00, 0x00, 0x00);
const D = bytes(0xff, 0xff, 0xff, 0xff);

async function reset(...prefixes: Uint8Array[]): Promise<HashPrefixList> {
    const sorted = [...prefixes].sort((a, b) => Buffer.compare(a, b));
    const bySize = new Map<number, Uint8Array[]>();
    for (const prefix of prefixes) bySize.set(prefix.length, [...(bySize.get(prefix.length) ?? []), prefix]);
    const list = await applyHashListUpdate(EMPTY_HASH_LIST, {
        kind: 'reset',
        additions: [...bySize].map(([prefixSize, hashes]) => ({ prefixSize, hashes: concat(...hashes) })),
        removals: [],
        checksum: await checksum(...sorted),
    });
    if (list === null) throw new Error('reset failed');
    return list;
}

describe('applyHashListUpdate', () => {
    it('sorts a reset across prefix lengths and checks it against the checksum', async () => {
        const list = await reset(D, B_LONG, C, A, B);
        expect(hashListSize(list)).toBe(5);
        expect(list.groups.get(4)).toEqual(concat(A, B, C, D));
        expect(list.groups.get(5)).toEqual(B_LONG);
    });

    it('removes by index in the old sorted order, then adds', async () => {
        const list = await reset(A, B, B_LONG, D);
        // Sorted: A 0, B 1, B_LONG 2, D 3. Remove B_LONG and A, add C.
        const next = await applyHashListUpdate(list, {
            kind: 'diff',
            additions: [{ prefixSize: 4, hashes: C }],
            removals: [2, 0],
            checksum: await checksum(B, C, D),
        });
        expect(next?.groups.get(4)).toEqual(concat(B, C, D));
        expect(next?.groups.has(5)).toBe(false);
        expect(
            await applyHashListUpdate(list, {
                kind: 'diff',
                additions: [],
                removals: [],
                checksum: await checksum(A, B, B_LONG, D),
            }),
        ).toEqual(list);
    });

    it('starts a reset from nothing, whatever the list held', async () => {
        const list = await reset(A, B);
        const next = await applyHashListUpdate(list, {
            kind: 'reset',
            additions: [{ prefixSize: 4, hashes: C }],
            removals: [],
            checksum: await checksum(C),
        });
        expect(next?.groups.get(4)).toEqual(C);
    });

    it.each<[string, (list: HashPrefixList) => Promise<HashListUpdate>]>([
        [
            'a checksum that does not match',
            async () => ({ kind: 'diff', additions: [], removals: [0], checksum: await checksum(A, B) }),
        ],
        [
            'a removal past the end',
            async () => ({ kind: 'diff', additions: [], removals: [2], checksum: await checksum(A, B) }),
        ],
        [
            'a negative removal',
            async () => ({ kind: 'diff', additions: [], removals: [-1], checksum: await checksum(A, B) }),
        ],
        [
            'a fractional removal',
            async () => ({ kind: 'diff', additions: [], removals: [0.5], checksum: await checksum(A, B) }),
        ],
        [
            'a removal given twice',
            async () => ({ kind: 'diff', additions: [], removals: [0, 0], checksum: await checksum(B) }),
        ],
        [
            'a prefix shorter than 4 bytes',
            async () => ({
                kind: 'diff',
                additions: [{ prefixSize: 3, hashes: bytes(1, 2, 3) }],
                removals: [],
                checksum: await checksum(A, B),
            }),
        ],
        [
            'a prefix longer than 32 bytes',
            async () => ({
                kind: 'diff',
                additions: [{ prefixSize: 33, hashes: new Uint8Array(33) }],
                removals: [],
                checksum: await checksum(A, B),
            }),
        ],
        [
            'hashes that do not divide into prefixes',
            async () => ({
                kind: 'diff',
                additions: [{ prefixSize: 4, hashes: bytes(1, 2, 3, 4, 5) }],
                removals: [],
                checksum: await checksum(A, B),
            }),
        ],
    ])('refuses %s', async (_, update) => {
        const list = await reset(A, B);
        expect(await applyHashListUpdate(list, await update(list))).toBeNull();
    });
});

describe('matchingPrefixes', () => {
    it('finds every prefix a full hash starts with, of any length', async () => {
        const list = await reset(A, B, B_LONG, C, D);
        const full = concat(B_LONG, new Uint8Array(27).fill(7));
        expect(matchingPrefixes(list, full)).toEqual([B, B_LONG]);
        expect(matchingPrefixes(list, concat(D, new Uint8Array(28)))).toEqual([D]);
        expect(matchingPrefixes(list, concat(A, new Uint8Array(28)))).toEqual([A]);
        expect(matchingPrefixes(list, new Uint8Array(32).fill(0x42))).toEqual([]);
        expect(matchingPrefixes(EMPTY_HASH_LIST, full)).toEqual([]);
    });
});

describe('encodeHashList', () => {
    it('round-trips a list', async () => {
        const list = await reset(A, B, B_LONG, C);
        expect(decodeHashList(encodeHashList(list))).toEqual(list);
        expect(decodeHashList(encodeHashList(EMPTY_HASH_LIST))).toEqual(EMPTY_HASH_LIST);
    });

    it.each([
        ['another version', bytes(2)],
        ['nothing', bytes()],
        ['a cut-off header', bytes(1, 4, 0, 0)],
        ['a cut-off group', bytes(1, 4, 0, 0, 0, 8, 1, 2, 3, 4)],
        ['an impossible prefix length', bytes(1, 3, 0, 0, 0, 3, 1, 2, 3)],
        ['a byte length that does not divide', bytes(1, 4, 0, 0, 0, 5, 1, 2, 3, 4, 5)],
        ['a length given twice', bytes(1, 4, 0, 0, 0, 4, 1, 2, 3, 4, 4, 0, 0, 0, 4, 5, 6, 7, 8)],
    ])('refuses %s', (_, encoded) => {
        expect(decodeHashList(encoded)).toBeNull();
    });
});
