import type { Bytes, EngineId, Signer } from '@ptbk/protocol';
import { deriveEngineId } from '@ptbk/protocol';

/** The engine's Ed25519 identity. The private key stays inside `sign` (a non-extractable WebCrypto key). */
export interface EngineIdentity {
    readonly engineId: EngineId;
    /** Raw 32-byte public key; the engine ID is derived from it. */
    readonly publicKey: Bytes;
    sign(message: Bytes, signal?: AbortSignal): Promise<Bytes>;
}

export interface IdentityStore {
    /** Loads the persisted identity, creating and persisting one on first start. */
    loadOrCreate(): Promise<EngineIdentity>;
}

export async function engineIdentityFromSigner(signer: Signer): Promise<EngineIdentity> {
    const publicKey = signer.publicKey();
    const engineId = await deriveEngineId(publicKey);
    return Object.freeze({
        engineId,
        publicKey,
        sign: (message: Bytes, signal?: AbortSignal) => signer.sign(message, signal),
    });
}

/** The protocol helpers take a `Signer`; this adapts an identity without exposing anything more. */
export function signerOf(identity: EngineIdentity): Signer {
    return {
        publicKey: () => identity.publicKey.slice(),
        sign: (message, signal) => identity.sign(message, signal),
    };
}
