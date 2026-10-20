import type { Bytes } from './bytes';

/** The only source of tokens, nonces and link codes. */
export interface Random {
    bytes(length: number): Bytes;
}

// `getRandomValues` throws a QuotaExceededError above this many bytes per call.
const MAX_GET_RANDOM_VALUES_BYTES = 65_536;

export function assertByteLength(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0) {
        throw new RangeError('length must be a non-negative integer');
    }
}

export function createCryptoRandom(): Random {
    return {
        bytes(length) {
            assertByteLength(length);
            const result = new Uint8Array(length);
            for (let offset = 0; offset < length; offset += MAX_GET_RANDOM_VALUES_BYTES) {
                crypto.getRandomValues(result.subarray(offset, offset + MAX_GET_RANDOM_VALUES_BYTES));
            }
            return result;
        },
    };
}
