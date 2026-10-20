import { createWebCryptoSigner, generateEd25519KeyPair } from '@ptbk/protocol';

import type { EngineIdentity, IdentityStore } from '../domain/identity/engine-identity';
import { engineIdentityFromSigner } from '../domain/identity/engine-identity';

/** A fresh, non-extractable identity per store, kept for the store's lifetime; for tests and throwaway runs. */
export function createMemoryIdentityStore(): IdentityStore {
    let identity: Promise<EngineIdentity> | undefined;
    return {
        loadOrCreate() {
            identity ??= generateEd25519KeyPair({ extractable: false })
                .then((keyPair) => createWebCryptoSigner(keyPair))
                .then((signer) => engineIdentityFromSigner(signer));
            return identity;
        },
    };
}
