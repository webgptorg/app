import type { CertificateClaims, ProvenanceVerifier } from '@ptbk/protocol';
import { FULCIO_OID, bytesEqual, checkCertificateClaims } from '@ptbk/protocol';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import type { SignedEntity } from '@sigstore/verify';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';

const ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';

/** How a broken engine reads provenance; `strict` is what the guide asks for. */
export type ProvenanceMode = 'strict' | 'contains-san' | 'lenient-extensions' | 'log-optional' | 'accept-all';

/** A DER UTF8String or, for `lenient`, whatever bytes are there read as UTF-8. */
function utf8Of(der: Uint8Array, lenient: boolean): string | undefined {
    if (der[0] === 0x0c && der.length >= 2 && (der[1] ?? 0) < 0x80 && der.length === 2 + (der[1] ?? 0)) {
        return new TextDecoder().decode(der.subarray(2));
    }
    return lenient ? new TextDecoder().decode(der) : undefined;
}

function latest(timestamps: SignedEntity['timestamps']): Date | null {
    let best: number | null = null;
    for (const timestamp of timestamps) {
        const time =
            timestamp.$case === 'timestamp-authority'
                ? timestamp.timestamp.signingTime.getTime()
                : timestamp.tlogEntry.inclusionPromise === undefined
                  ? null
                  : Number(timestamp.tlogEntry.integratedTime) * 1000;
        if (time !== null && (best === null || time > best)) best = time;
    }
    return best === null ? null : new Date(best);
}

/**
 * The fake engines' `ProvenanceVerifier`, on `@sigstore/verify` like the reference adapter in `@ptbk/release-tools`
 * (which the suite may not import); a mode other than `strict` is a deliberate defect.
 */
export function createFakeSigstoreVerifier(trustedRoot: unknown, mode: ProvenanceMode): ProvenanceVerifier {
    const material = toTrustMaterial(TrustedRoot.fromJSON(trustedRoot));
    const logged = new Verifier(material, { tlogThreshold: 1, ctlogThreshold: 1 });
    const unlogged = new Verifier(material, { tlogThreshold: 0, ctlogThreshold: 1 });
    return {
        verifyProvenance(text, envelope, expected) {
            if (mode === 'accept-all')
                return Promise.resolve({ kind: 'verified', logIndex: 0, trustedTime: new Date() });
            try {
                const bundle = bundleFromJSON(JSON.parse(text));
                if (bundle.content.$case !== 'dsseEnvelope')
                    return Promise.resolve({ kind: 'invalid', reason: 'not-dsse' });
                const dsse = bundle.content.dsseEnvelope;
                if (
                    dsse.payloadType !== envelope.payloadType ||
                    !bytesEqual(new Uint8Array(dsse.payload), envelope.payload)
                ) {
                    return Promise.resolve({ kind: 'invalid', reason: 'payload-mismatch' });
                }
                const hasLog = bundle.verificationMaterial.tlogEntries.length > 0;
                const entity = toSignedEntity(bundle);
                const signer = (hasLog ? logged : unlogged).verify(entity);
                const extensions = new Map<string, string>();
                for (const { oid, value } of signer.identity?.oids ?? []) {
                    const id = (oid?.id ?? []).join('.');
                    if (id !== ISSUER_V2 && !Object.values<string>(FULCIO_OID).includes(id)) continue;
                    const decoded = utf8Of(new Uint8Array(value), mode === 'lenient-extensions');
                    if (decoded === undefined) return Promise.resolve({ kind: 'invalid', reason: 'not-utf8string' });
                    extensions.set(id, decoded);
                }
                const san = signer.identity?.subjectAlternativeName ?? '';
                const claims: CertificateClaims = {
                    issuer: extensions.get(ISSUER_V2) ?? '',
                    subjectAlternativeName:
                        mode === 'contains-san' && san.includes(expected.subjectAlternativeName)
                            ? expected.subjectAlternativeName
                            : san,
                    extensions,
                };
                if (checkCertificateClaims(claims, expected).kind === 'mismatch') {
                    return Promise.resolve({ kind: 'invalid', reason: 'identity-mismatch' });
                }
                if (!hasLog) {
                    return Promise.resolve(
                        mode === 'log-optional'
                            ? { kind: 'verified', logIndex: 0, trustedTime: new Date() }
                            : { kind: 'not-in-log', reason: 'no-tlog-entry' },
                    );
                }
                return Promise.resolve({
                    kind: 'verified',
                    logIndex: Number(entity.tlogEntries[0]?.logIndex),
                    trustedTime: latest(entity.timestamps),
                });
            } catch {
                return Promise.resolve({ kind: 'invalid', reason: 'verification-error' });
            }
        },
    };
}
