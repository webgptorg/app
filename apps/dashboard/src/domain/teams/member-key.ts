import {
    createWebCryptoSigner,
    ed25519PublicKeyFromBytes,
    importEd25519PrivateKey,
    type Ed25519PublicKey,
    type Signer,
} from '@ptbk/protocol';

/** The dashboard's member key (ADR 0018): signs access tickets and member revocations, nothing else. */
export interface MemberKey {
    readonly signer: Signer;
    readonly publicKey: Ed25519PublicKey;
}

/** Null without a configured key: then no tickets are issued and revocations wait, queued. */
export type MemberKeySource = () => Promise<MemberKey | null>;

/** Loads the 32-byte seed once, non-extractable, on first use. */
export function memberKeySource(seed: Uint8Array<ArrayBuffer> | null): MemberKeySource {
    let loaded: Promise<MemberKey | null> | null = null;
    return () => {
        loaded ??=
            seed === null
                ? Promise.resolve(null)
                : importEd25519PrivateKey(seed, { extractable: false })
                      .then(createWebCryptoSigner)
                      .then((signer) => ({ signer, publicKey: ed25519PublicKeyFromBytes(signer.publicKey()) }));
        return loaded;
    };
}
