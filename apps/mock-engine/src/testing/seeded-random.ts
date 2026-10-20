import type { Random } from '../domain/random';

/**
 * Deterministic `Random` for tests (SplitMix32, as in the protocol package, which keeps its copy private). Predictable
 * by design: only tests import `src/testing/`, and no entry point does, so it never ships.
 */
export function createSeededRandom(seed: number): Random {
    let state = seed >>> 0;
    function next(): number {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
        return (z ^ (z >>> 16)) >>> 0;
    }
    return {
        bytes(length) {
            if (!Number.isSafeInteger(length) || length < 0)
                throw new RangeError('length must be a non-negative integer');
            const result = new Uint8Array(length);
            for (let index = 0; index < length; index++) result[index] = next() & 0xff;
            return result;
        },
    };
}

/** A `Random` that returns the given bytes, then zeros: pins jitter to exact values. */
export function createFixedRandom(bytes: readonly number[]): Random {
    let offset = 0;
    return {
        bytes(length) {
            const result = new Uint8Array(length);
            for (let index = 0; index < length; index++) result[index] = bytes[offset++] ?? 0;
            return result;
        },
    };
}
