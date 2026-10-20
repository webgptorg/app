import type { Signer, TrustPolicy } from '@ptbk/protocol';
import {
    RELEASE_PAYLOAD_TYPE,
    SignedRelease,
    createWebCryptoSigner,
    decodeBase64Url,
    ed25519PublicKeyFromBytes,
    importEd25519PrivateKey,
    signDsse,
} from '@ptbk/protocol';

export class ReleaseKeyError extends Error {
    override readonly name = 'ReleaseKeyError';
}

/** A release key seed as stored in a secret: canonical base64url of the 32-byte RFC 8032 seed. */
export async function releaseSignerFromSeed(seed: string): Promise<Signer> {
    const decoded = decodeBase64Url(seed.trim());
    if (decoded.kind === 'invalid' || decoded.bytes.length !== 32) {
        throw new ReleaseKeyError('the release key must be base64url of a 32-byte Ed25519 seed');
    }
    return createWebCryptoSigner(await importEd25519PrivateKey(decoded.bytes, { extractable: false }));
}

export interface SignReleaseInput {
    readonly payload: Uint8Array<ArrayBuffer>;
    readonly provenance: string;
    readonly seed: string;
    readonly policy: TrustPolicy;
}

/**
 * Signs the DSSE PAE of the payload bytes with a release key and pairs the envelope with the CI provenance. Refuses a
 * key the policy does not list as a release key, so the staging key can never sign for a production policy.
 */
export async function signRelease(input: SignReleaseInput): Promise<SignedRelease> {
    const signer = await releaseSignerFromSeed(input.seed);
    const publicKey = ed25519PublicKeyFromBytes(signer.publicKey());
    if (!input.policy.releaseKeys.some((key) => key.publicKey === publicKey)) {
        throw new ReleaseKeyError('this key is not a release key of the trust policy');
    }
    const envelope = await signDsse(signer, RELEASE_PAYLOAD_TYPE, input.payload);
    return SignedRelease.parse({ v: 1, envelope, provenance: input.provenance });
}
