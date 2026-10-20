/**
 * A deterministic number sequence for fake data: seed records, IDs and generated replies.
 *
 * This is deliberately not the `Random` port. Seed data must come out identical for the same `MOCK_SEED`, so runs,
 * screenshots and conformance reports are reproducible; anything an attacker must not guess (session IDs, cookies)
 * draws from the crypto-backed `Random` port instead and never from here.
 */
export interface SeededSequence {
    /** Uniform in [0, 1). */
    next(): number;
    /** Uniform integer in [min, max], both inclusive. */
    int(min: number, max: number): number;
    /** True with probability `p`. */
    chance(p: number): boolean;
    pick<T>(items: readonly T[]): T;
    /** `<prefix>-` followed by 12 lowercase base32 characters (60 bits); a valid opaque ID of the engine API. */
    id(prefix: string): string;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_LENGTH = 12;

/** SplitMix32: tiny, fast and well distributed, which is all fake data needs. */
export function createSeededSequence(seed: number): SeededSequence {
    let state = seed >>> 0;
    function nextUint32(): number {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
        return (z ^ (z >>> 16)) >>> 0;
    }
    const next = (): number => nextUint32() / 2 ** 32;
    return {
        next,
        int(min, max) {
            if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
                throw new RangeError('int needs integer bounds with min <= max');
            }
            return min + Math.floor(next() * (max - min + 1));
        },
        chance: (p) => next() < p,
        pick(items) {
            if (items.length === 0) throw new RangeError('cannot pick from an empty list');
            return items[Math.floor(next() * items.length)] as (typeof items)[number];
        },
        id(prefix) {
            let suffix = '';
            for (let index = 0; index < ID_LENGTH; index++) suffix += ID_ALPHABET.charAt(nextUint32() & 31);
            return `${prefix}-${suffix}`;
        },
    };
}

/** FNV-1a over the parts joined with `:`, so `(seed, chatId, messageIndex)` names one independent sub-sequence. */
export function hashSeed(...parts: readonly (string | number)[]): number {
    let hash = 0x811c9dc5;
    const text = parts.map(String).join(':');
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
