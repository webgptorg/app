import { describe, expect, it } from 'vitest';
import type { Random } from './random';
import { createCryptoRandom } from './random';
import { createSeededRandom } from './testing/seeded-random';

describe.each<{ name: string; create: () => Random }>([
    { name: 'createCryptoRandom', create: createCryptoRandom },
    { name: 'createSeededRandom', create: () => createSeededRandom(42) },
])('Random port: $name', ({ create }) => {
    it.each([0, 1, 65_536, 100_000])('returns exactly %i bytes', (length) => {
        const bytes = create().bytes(length);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
        expect(bytes.length).toBe(length);
    });

    it('fills every chunk, including past the 65,536-byte getRandomValues limit', () => {
        const bytes = create().bytes(100_000);
        for (const start of [0, 65_536, 100_000 - 64]) {
            expect(bytes.subarray(start, start + 64).some((byte) => byte !== 0)).toBe(true);
        }
    });

    it('does not repeat itself', () => {
        const random = create();
        expect(random.bytes(32)).not.toEqual(random.bytes(32));
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('rejects length %s', (length) => {
        expect(() => create().bytes(length)).toThrow(RangeError);
    });
});

describe('createSeededRandom', () => {
    it('is deterministic per seed', () => {
        expect(createSeededRandom(7).bytes(16)).toEqual(createSeededRandom(7).bytes(16));
        expect(createSeededRandom(7).bytes(16)).not.toEqual(createSeededRandom(8).bytes(16));
    });
});
