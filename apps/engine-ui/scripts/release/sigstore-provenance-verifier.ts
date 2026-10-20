import { X509Certificate } from 'node:crypto';

import type {
    Bytes,
    CertificateClaims,
    ExpectedWorkflowClaims,
    ProvenanceVerification,
    ProvenanceVerifier,
} from '@ptbk/protocol';
import { FULCIO_OID, bytesEqual, checkCertificateClaims } from '@ptbk/protocol';
import type { Bundle } from '@sigstore/bundle';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import type { SignedEntity, Signer } from '@sigstore/verify';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';

/** Fulcio's v2 issuer extension, a DER UTF8String (the v1 `…1.1` holds raw bytes and is never read). */
export const FULCIO_ISSUER_V2_OID = '1.3.6.1.4.1.57264.1.8';

const UTF8_STRING_TAG = 0x0c;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A DER UTF8String exactly: tag 0x0C, definite minimal length, nothing after it, valid UTF-8 (a BOM is kept, not
 * stripped). `undefined` for anything else, so a certificate cannot pass a value that only decodes leniently.
 */
export function decodeDerUtf8String(der: Uint8Array): string | undefined {
    if (der.length < 2 || der[0] !== UTF8_STRING_TAG) return undefined;
    const first = der[1] ?? 0;
    let length = first;
    let offset = 2;
    if (first >= 0x80) {
        const lengthBytes = first & 0x7f;
        // 0x80 is BER's indefinite length; more than two length bytes is far beyond any certificate extension.
        if (lengthBytes === 0 || lengthBytes > 2 || der.length < 2 + lengthBytes) return undefined;
        length = 0;
        for (let index = 0; index < lengthBytes; index += 1) length = length * 256 + (der[2 + index] ?? 0);
        offset = 2 + lengthBytes;
        if (length < 0x80 || (lengthBytes === 2 && length < 0x100)) return undefined;
    }
    if (der.length !== offset + length) return undefined;
    try {
        return utf8.decode(der.subarray(offset));
    } catch {
        return undefined;
    }
}

type EntityTimestamp = SignedEntity['timestamps'][number];

/**
 * The latest timestamp `Verifier.verify` checked: every RFC 3161 timestamp, and the Rekor integrated time only where
 * the entry carries an inclusion promise (a signed entry timestamp), as `@sigstore/verify` verifies nothing else.
 * Call only after `verify` succeeded on the entity these came from.
 */
export function latestVerifiedTime(timestamps: readonly EntityTimestamp[]): Date | null {
    let latest: number | null = null;
    for (const timestamp of timestamps) {
        let time: number | null = null;
        switch (timestamp.$case) {
            case 'timestamp-authority':
                time = timestamp.timestamp.signingTime.getTime();
                break;
            case 'transparency-log':
                if (timestamp.tlogEntry.inclusionPromise !== undefined) {
                    time = Number(timestamp.tlogEntry.integratedTime) * 1000;
                }
                break;
        }
        if (time !== null && Number.isFinite(time) && (latest === null || time > latest)) latest = time;
    }
    return latest === null ? null : new Date(latest);
}

function oidString(id: readonly number[]): string {
    return id.join('.');
}

function leafCertificate(bundle: Bundle): Uint8Array | undefined {
    const content = bundle.verificationMaterial.content;
    switch (content.$case) {
        case 'certificate':
            return content.certificate.rawBytes;
        case 'x509CertificateChain':
            return content.x509CertificateChain.certificates[0]?.rawBytes;
        case 'publicKey':
            return undefined;
    }
}

export type ClaimsRead =
    { readonly kind: 'ok'; readonly claims: CertificateClaims } | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Reads the claims of the verified signer; `leafDer` is the certificate `verify` checked. The SAN must be the certificate's only subject alternative name and a URI:
 * Node's own parser must print it as exactly `URI:<san>`, which rules out email SANs, several names and anything it
 * would escape, since `@sigstore/core` decodes the SAN as lossy ASCII.
 */
export function readCertificateClaims(signer: Pick<Signer, 'identity'>, leafDer: Uint8Array): ClaimsRead {
    const identity = signer.identity;
    const san = identity?.subjectAlternativeName;
    if (identity === undefined || san === undefined || new X509Certificate(leafDer).subjectAltName !== `URI:${san}`) {
        return { kind: 'invalid', reason: 'san-not-a-single-uri' };
    }
    const extensions = new Map<string, string>();
    const wanted = new Set<string>([FULCIO_ISSUER_V2_OID, ...Object.values(FULCIO_OID)]);
    const seen = new Set<string>();
    for (const { oid, value } of identity.oids ?? []) {
        const id = oidString(oid?.id ?? []);
        if (seen.has(id)) return { kind: 'invalid', reason: 'duplicate-extension' };
        seen.add(id);
        if (!wanted.has(id)) continue;
        const decoded = decodeDerUtf8String(value);
        if (decoded === undefined) return { kind: 'invalid', reason: `extension-not-utf8string:${id}` };
        extensions.set(id, decoded);
    }
    const issuer = extensions.get(FULCIO_ISSUER_V2_OID);
    if (issuer === undefined) return { kind: 'invalid', reason: 'missing-issuer' };
    return { kind: 'ok', claims: { issuer, subjectAlternativeName: san, extensions } };
}

function parseBundle(text: string): Bundle | undefined {
    try {
        return bundleFromJSON(JSON.parse(text));
    } catch {
        return undefined;
    }
}

function errorCode(error: unknown): string {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
    return 'verification-error';
}

/**
 * C-06's `ProvenanceVerifier` on `@sigstore/verify` directly, against a pinned trusted root (no TUF fetch): Fulcio
 * chain, one SCT, one Rekor entry and every timestamp verified, then the exact payload, payload type and certificate
 * claims. `sigstore.verify()` is never used: it matches identities by unanchored pattern and compares raw DER.
 */
export function createSigstoreProvenanceVerifier(trustedRoot: unknown): ProvenanceVerifier {
    const trustMaterial = toTrustMaterial(TrustedRoot.fromJSON(trustedRoot));
    const verifier = new Verifier(trustMaterial, { tlogThreshold: 1, ctlogThreshold: 1 });
    // Only for a bundle without any log entry, to tell "valid but not logged" (not-in-log) from "invalid"; its result
    // is never `verified`.
    const unloggedVerifier = new Verifier(trustMaterial, { tlogThreshold: 0, ctlogThreshold: 1 });

    function verify(
        text: string,
        envelope: { readonly payloadType: string; readonly payload: Bytes },
        expected: ExpectedWorkflowClaims,
    ): ProvenanceVerification {
        const bundle = parseBundle(text);
        if (bundle === undefined) return { kind: 'invalid', reason: 'malformed-bundle' };
        if (bundle.content.$case !== 'dsseEnvelope') return { kind: 'invalid', reason: 'not-a-dsse-bundle' };
        const dsse = bundle.content.dsseEnvelope;
        if (dsse.payloadType !== envelope.payloadType || !bytesEqual(new Uint8Array(dsse.payload), envelope.payload)) {
            return { kind: 'invalid', reason: 'payload-mismatch' };
        }
        const leafDer = leafCertificate(bundle);
        if (leafDer === undefined) return { kind: 'invalid', reason: 'no-certificate' };
        const logged = bundle.verificationMaterial.tlogEntries.length > 0;

        let entity: SignedEntity;
        let signer: Signer;
        try {
            entity = toSignedEntity(bundle);
            signer = (logged ? verifier : unloggedVerifier).verify(entity);
        } catch (error) {
            return { kind: 'invalid', reason: errorCode(error) };
        }
        const read = readCertificateClaims(signer, leafDer);
        if (read.kind === 'invalid') return read;
        const match = checkCertificateClaims(read.claims, expected);
        if (match.kind === 'mismatch') return { kind: 'invalid', reason: `identity-mismatch:${match.field}` };
        if (!logged) return { kind: 'not-in-log', reason: 'no-tlog-entry' };

        // The entry's signed entry timestamp or inclusion proof covers its log index.
        const logIndex = Number(entity.tlogEntries[0]?.logIndex);
        return { kind: 'verified', logIndex, trustedTime: latestVerifiedTime(entity.timestamps) };
    }

    return {
        verifyProvenance(bundle, envelope, expected, signal) {
            return Promise.resolve().then(() => {
                signal.throwIfAborted();
                const result = verify(bundle, envelope, expected);
                signal.throwIfAborted();
                return result;
            });
        },
    };
}
