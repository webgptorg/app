import { createWebCryptoSigner, generateEd25519KeyPair } from '@ptbk/protocol';

import type { EngineIdentity } from '../domain/identity/engine-identity';
import { engineIdentityFromSigner } from '../domain/identity/engine-identity';

/** A fresh, non-extractable engine identity for domain tests, which may not import adapters. */
export async function createTestIdentity(): Promise<EngineIdentity> {
    return engineIdentityFromSigner(await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false })));
}
