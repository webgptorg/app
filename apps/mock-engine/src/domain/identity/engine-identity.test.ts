import {
    createWebCryptoSigner,
    deriveEngineId,
    generateEd25519KeyPair,
    utf8Encode,
    verifyEd25519,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { engineIdentityFromSigner, signerOf } from './engine-identity';

async function freshSigner() {
    return createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
}

describe('engineIdentityFromSigner', () => {
    it('derives the engine ID from the public key and signs with the signer', async () => {
        const signer = await freshSigner();
        const identity = await engineIdentityFromSigner(signer);
        expect(identity.publicKey).toEqual(signer.publicKey());
        expect(identity.engineId).toBe(await deriveEngineId(signer.publicKey()));
        expect(Object.isFrozen(identity)).toBe(true);
        const message = utf8Encode('ptbk-test');
        expect(verifyEd25519(identity.publicKey, message, await identity.sign(message))).toBe(true);
    });

    it('passes the abort signal to the signer', async () => {
        const identity = await engineIdentityFromSigner(await freshSigner());
        await expect(identity.sign(utf8Encode('x'), AbortSignal.abort())).rejects.toThrow();
    });
});

describe('signerOf', () => {
    it('exposes the identity as a Signer, returning a copy of the public key', async () => {
        const identity = await engineIdentityFromSigner(await freshSigner());
        const signer = signerOf(identity);
        const publicKey = signer.publicKey();
        expect(publicKey).toEqual(identity.publicKey);
        publicKey.fill(0);
        expect(signer.publicKey()).toEqual(identity.publicKey);
        const message = utf8Encode('ptbk-test');
        expect(verifyEd25519(identity.publicKey, message, await signer.sign(message))).toBe(true);
        await expect(signer.sign(message, AbortSignal.abort())).rejects.toThrow();
    });
});
