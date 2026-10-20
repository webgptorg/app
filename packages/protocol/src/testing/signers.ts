import type { Bytes } from '../bytes';
import type { Signer } from '../ed25519';
import { createWebCryptoSigner, generateEd25519KeyPair, importEd25519PrivateKey } from '../ed25519';
import { deriveEngineId } from '../engine-id';
import type { EngineId } from '../ids';
import vectors from '../signed-message-vectors.json';
import { fromHex } from './hex';

export interface TestIdentity {
    readonly signer: Signer;
    readonly publicKey: Bytes;
    readonly engineId: EngineId;
}

async function identityOf(keyPair: CryptoKeyPair): Promise<TestIdentity> {
    const signer = await createWebCryptoSigner(keyPair);
    return { signer, publicKey: signer.publicKey(), engineId: await deriveEngineId(signer.publicKey()) };
}

/** The published RFC 8032 key the golden vectors are signed with. */
export async function vectorIdentity(): Promise<TestIdentity> {
    return identityOf(await importEd25519PrivateKey(fromHex(vectors.key.seedHex), { extractable: false }));
}

export async function freshIdentity(): Promise<TestIdentity> {
    return identityOf(await generateEd25519KeyPair({ extractable: false }));
}
