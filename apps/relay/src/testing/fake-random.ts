import type { Random } from '../domain/random';

export interface FakeRandom extends Random {
    /** Calls so far. */
    calls(): number;
}

/** Deterministic and never repeating: call `n` fills its bytes from a counter starting at `n`. */
export function createFakeRandom(): FakeRandom {
    let calls = 0;
    return {
        bytes(length) {
            const seed = ++calls;
            return Uint8Array.from({ length }, (_, index) => (seed * 31 + index) & 0xff);
        },
        calls: () => calls,
    };
}
