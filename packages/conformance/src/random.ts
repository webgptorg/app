import type { Random } from '@ptbk/protocol';

const MAX_SEED = 2 ** 32 - 1;

/**
 * A reproducible byte sequence for test data (resource names, canaries), so a failing run can be repeated with the
 * same seed. Never for credentials: nothing the suite generates protects anything.
 */
export function createSeededRandom(seed: number): Random {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
        throw new RangeError('seed must be an integer from 0 to 2^32 - 1');
    }
    let state = seed >>> 0;
    // mulberry32: tiny, well distributed and plenty for test data.
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return (value ^ (value >>> 14)) >>> 0;
    };
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

/** A fresh seed from the platform's CSPRNG, for runs that do not pass one. */
export function randomSeed(): number {
    return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Lowercase letters and digits only, so the text survives JSON, URLs and case-insensitive matching unchanged. */
export function randomToken(random: Random, length: number): string {
    return Array.from(random.bytes(length), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}
