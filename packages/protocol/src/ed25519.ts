import { ed25519 } from '@noble/curves/ed25519.js';

import type { Bytes } from './bytes';
import { concatBytes } from './bytes';
import { ED25519_PUBLIC_KEY_BYTES, ED25519_SIGNATURE_BYTES } from './ids';

export interface Signer {
    publicKey(): Bytes;
    sign(message: Bytes, signal?: AbortSignal): Promise<Bytes>;
}

export interface KeyOptions {
    /** `true` only where the private key must be persisted (e.g. the mock engine); runtime keys are non-extractable. */
    readonly extractable: boolean;
}

const ALGORITHM = 'Ed25519';
const SEED_BYTES = 32;
// RFC 8410 PrivateKeyInfo for Ed25519 up to its 32-byte CurvePrivateKey (the RFC 8032 seed), which follows it.
// prettier-ignore
const PKCS8_SEED_PREFIX = Uint8Array.of(
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
);

export async function generateEd25519KeyPair({ extractable }: KeyOptions): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(ALGORITHM, extractable, ['sign', 'verify']);
}

/** Loads a 32-byte RFC 8032 seed (a stored key, or a test vector) into WebCrypto. */
export async function importEd25519PrivateKey(seed: Bytes, { extractable }: KeyOptions): Promise<CryptoKeyPair> {
    if (seed.length !== SEED_BYTES) throw new RangeError(`Ed25519 seed must be ${String(SEED_BYTES)} bytes`);
    const [privateKey, publicKey] = await Promise.all([
        crypto.subtle.importKey('pkcs8', concatBytes(PKCS8_SEED_PREFIX, seed), ALGORITHM, extractable, ['sign']),
        crypto.subtle.importKey('raw', ed25519.getPublicKey(seed), ALGORITHM, true, ['verify']),
    ]);
    return { privateKey, publicKey };
}

/** Exports the raw public key once, so `publicKey()` stays synchronous. */
export async function createWebCryptoSigner(keyPair: CryptoKeyPair): Promise<Signer> {
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    return {
        publicKey: () => publicKey.slice(),
        async sign(message, signal) {
            signal?.throwIfAborted();
            const signature = new Uint8Array(await crypto.subtle.sign(ALGORITHM, keyPair.privateKey, message));
            signal?.throwIfAborted();
            return signature;
        },
    };
}

/**
 * The protocol's definition of a valid signature (ADR 0014): noble's strict mode, `zip215: false`, which requires
 * canonical A and R (y < p, no negative zero), S < L and A not of small order, then checks the cofactored equation.
 * Small- or mixed-order R and mixed-order A are accepted when the equation holds. WebCrypto never verifies, because
 * runtimes differ on these edge cases; `src/ed25519-vectors.json` pins the behaviour. Never throws.
 */
export function verifyEd25519(publicKey: Bytes, message: Bytes, signature: Bytes): boolean {
    if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES || signature.length !== ED25519_SIGNATURE_BYTES) return false;
    try {
        return ed25519.verify(signature, message, publicKey, { zip215: false });
    } catch {
        return false;
    }
}
