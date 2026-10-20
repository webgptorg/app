import { z } from 'zod';

import { encodeBase64Url } from '../base64url';
import { decodeBase64Std, encodeBase64Std } from '../base64std';
import type { Bytes } from '../bytes';
import { concatBytes, utf8Encode } from '../bytes';
import type { Signer } from '../ed25519';
import { verifyEd25519 } from '../ed25519';
import { ED25519_PUBLIC_KEY_BYTES, ED25519_SIGNATURE_BYTES, base64UrlOfLength } from '../ids';

export const RELEASE_PAYLOAD_TYPE = 'application/vnd.ptbk.release+json; v=1';
export const REVOCATION_PAYLOAD_TYPE = 'application/vnd.ptbk.revocation+json; v=1';

/** Large enough for a revocation list at its limits (1,000 entries, 500-character reasons, every character escaped). */
export const DSSE_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const DSSE_MAX_SIGNATURES = 16;
const MAX_PAYLOAD_TYPE_LENGTH = 256;
const KEY_ID_BYTES = 32;

function base64StdOf(maxBytes: number, exactBytes?: number) {
    return z
        .string()
        .max(Math.ceil(maxBytes / 3) * 4)
        .refine((text) => {
            const decoded = decodeBase64Std(text);
            return decoded.kind === 'ok' && (exactBytes === undefined || decoded.bytes.length === exactBytes);
        }, 'expected canonical standard base64 with padding');
}

/** `keyid` is base64url like every byte string outside DSSE's own fields; `sig` is DSSE's standard base64. */
export const DsseSignature = z.strictObject({
    keyid: base64UrlOfLength(KEY_ID_BYTES),
    sig: base64StdOf(ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BYTES),
});
export type DsseSignature = z.infer<typeof DsseSignature>;

export const DsseEnvelope = z.strictObject({
    payloadType: z
        .string()
        .min(1)
        .max(MAX_PAYLOAD_TYPE_LENGTH)
        .regex(/^[\x20-\x7e]+$/),
    payload: base64StdOf(DSSE_MAX_PAYLOAD_BYTES),
    signatures: z.array(DsseSignature).min(1).max(DSSE_MAX_SIGNATURES),
});
export type DsseEnvelope = z.infer<typeof DsseEnvelope>;

const SPACE = utf8Encode(' ');

/** DSSE v1 pre-authentication encoding: `"DSSEv1" SP len(type) SP type SP len(body) SP body`, lengths in bytes. */
export function pae(payloadType: string, payload: Bytes): Bytes {
    const type = utf8Encode(payloadType);
    return concatBytes(
        utf8Encode(`DSSEv1 ${String(type.length)} `),
        type,
        utf8Encode(` ${String(payload.length)}`),
        SPACE,
        payload,
    );
}

/** base64url(SHA-256(raw 32-byte public key)). Throws on another length, which is a bug in the caller. */
export async function dsseKeyId(publicKey: Bytes): Promise<string> {
    if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) throw new RangeError('Ed25519 public key must be 32 bytes');
    return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey)));
}

/** Decodes a payload that already passed `DsseEnvelope`. */
export function dssePayload(envelope: DsseEnvelope): Bytes {
    const decoded = decodeBase64Std(envelope.payload);
    // Unreachable for a parsed envelope; kept so a forged type (a cast) fails loudly.
    if (decoded.kind === 'invalid') throw new TypeError('payload is not standard base64');
    return decoded.bytes;
}

/**
 * One envelope signed by every signer over the same PAE. Signatures made separately (a hardware key, another
 * maintainer) are added by concatenating `signatures` of envelopes over identical `payloadType` and `payload`.
 */
export async function signDsse(
    signers: Signer | readonly Signer[],
    payloadType: string,
    payload: Bytes,
    signal?: AbortSignal,
): Promise<DsseEnvelope> {
    const message = pae(payloadType, payload);
    const signatures: DsseSignature[] = [];
    const list: readonly Signer[] = 'sign' in signers ? [signers] : signers;
    for (const signer of list) {
        const sig = await signer.sign(message, signal);
        signatures.push({ keyid: await dsseKeyId(signer.publicKey()), sig: encodeBase64Std(sig) });
    }
    return DsseEnvelope.parse({ payloadType, payload: encodeBase64Std(payload), signatures });
}

/**
 * The key IDs of `keys` with at least one valid signature (strict `verifyEd25519`) over the envelope's PAE.
 * Signatures under unknown key IDs are ignored, a key signing twice counts once, and nothing here throws.
 */
export async function verifyDsseSignatures(
    envelope: DsseEnvelope,
    keys: readonly Bytes[],
): Promise<ReadonlySet<string>> {
    const byId = new Map<string, Bytes>();
    for (const key of keys) byId.set(await dsseKeyId(key), key);
    const message = pae(envelope.payloadType, dssePayload(envelope));
    const valid = new Set<string>();
    for (const { keyid, sig } of envelope.signatures) {
        const key = byId.get(keyid);
        const signature = decodeBase64Std(sig);
        if (key !== undefined && signature.kind === 'ok' && verifyEd25519(key, message, signature.bytes)) {
            valid.add(keyid);
        }
    }
    return valid;
}
