import type { Random } from '../random';
import { assertByteLength } from '../random';

/**
 * Deterministic `Random` for tests (SplitMix32). Predictable by design: never wire it outside tests. It is
 * deliberately not exported from the package, so no app can reach it.
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
            assertByteLength(length);
            const result = new Uint8Array(length);
            for (let index = 0; index < length; index++) {
                result[index] = next() & 0xff;
            }
            return result;
        },
    };
}
