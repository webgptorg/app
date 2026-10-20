import { createCryptoRandom } from '@ptbk/protocol';

import type { Random } from '../domain/random';

/** `crypto.getRandomValues`, Node's CSPRNG; the only `Random` the relay runs with outside tests. */
export function createNodeRandom(): Random {
    return createCryptoRandom();
}
