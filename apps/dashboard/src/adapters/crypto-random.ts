import type { Random } from '../domain/ports/random';

export const cryptoRandom: Random = {
    bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};
