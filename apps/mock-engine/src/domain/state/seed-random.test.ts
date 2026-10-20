import { describe, expect, it } from 'vitest';

import { createSeededSequence, hashSeed } from './seed-random';

describe('createSeededSequence', () => {
    it('repeats exactly for the same seed and differs for another', () => {
        const draw = (seed: number) => {
            const sequence = createSeededSequence(seed);
            return Array.from({ length: 8 }, () => sequence.next());
        };
        expect(draw(7)).toEqual(draw(7));
        expect(draw(7)).not.toEqual(draw(8));
    });

    it('stays within its bounds', () => {
        const sequence = createSeededSequence(1);
        for (let index = 0; index < 1_000; index++) {
            const value = sequence.next();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
            const integer = sequence.int(3, 5);
            expect([3, 4, 5]).toContain(integer);
        }
        expect(sequence.int(4, 4)).toBe(4);
    });

    it('covers every integer in a range and the chance roughly matches p', () => {
        const sequence = createSeededSequence(2);
        const seen = new Set(Array.from({ length: 200 }, () => sequence.int(0, 9)));
        expect(seen.size).toBe(10);
        const hits = Array.from({ length: 10_000 }, () => sequence.chance(0.3)).filter(Boolean).length;
        expect(hits / 10_000).toBeCloseTo(0.3, 1);
    });

    it('picks from a list and refuses empty lists and bad bounds', () => {
        const sequence = createSeededSequence(3);
        expect(['a', 'b']).toContain(sequence.pick(['a', 'b']));
        expect(() => sequence.pick([])).toThrow(RangeError);
        expect(() => sequence.int(2, 1)).toThrow(RangeError);
        expect(() => sequence.int(0.5, 1)).toThrow(RangeError);
    });

    it('makes opaque engine API IDs', () => {
        const sequence = createSeededSequence(4);
        const ids = Array.from({ length: 100 }, () => sequence.id('agent'));
        for (const id of ids) expect(id).toMatch(/^agent-[a-z2-7]{12}$/);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('hashSeed', () => {
    it('derives independent, stable sub-seeds from its parts', () => {
        expect(hashSeed(42, 'chat-a', 0)).toBe(hashSeed(42, 'chat-a', 0));
        expect(hashSeed(42, 'chat-a', 0)).not.toBe(hashSeed(42, 'chat-a', 1));
        expect(hashSeed(42, 'chat-a', 0)).not.toBe(hashSeed(43, 'chat-a', 0));
        expect(hashSeed('a')).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(hashSeed('a'))).toBe(true);
    });
});
