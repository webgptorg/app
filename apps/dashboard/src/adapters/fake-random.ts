import type { Random } from '../domain/ports/random';

/** Deterministic, not random: a counter so tests get distinct, reproducible values. */
export function createFakeRandom(seed = 0): Random {
    let next = seed;
    return {
        bytes(length) {
            const out = new Uint8Array(length);
            for (let i = 0; i < length; i++) {
                out[i] = next & 0xff;
                next++;
            }
            return out;
        },
    };
}
