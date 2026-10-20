import type { Bytes } from '../bytes';
import { bytesEqual } from '../bytes';
import type {
    CertificateClaims,
    ExpectedWorkflowClaims,
    ProvenanceVerification,
    ProvenanceVerifier,
} from './provenance';
import { checkCertificateClaims } from './provenance';

/** What Sigstore would have verified about one bundle, standing in for the real certificate, log and timestamps. */
export interface FakeAttestation {
    /** The opaque bundle text this attestation answers for, compared exactly. */
    readonly bundle: string;
    readonly payloadType: string;
    readonly payload: Bytes;
    readonly certificate: CertificateClaims;
    /** `null`: the bundle has no transparency log entry. */
    readonly logIndex: number | null;
    /** Verified RFC 3161 and Rekor integrated times; empty when the bundle has none. */
    readonly timestamps: readonly Date[];
}

/**
 * Tests and e2e only: a `ProvenanceVerifier` that knows only the given bundles and applies the port contract's exact
 * matching to them (payload, payload type, `checkCertificateClaims`, log entry, latest timestamp). Any other bundle
 * text is invalid, so wiring it by mistake accepts nothing beyond what a test configured.
 */
export function createFakeProvenanceVerifier(attestations: readonly FakeAttestation[]): ProvenanceVerifier {
    const byBundle = new Map(attestations.map((attestation) => [attestation.bundle, attestation]));
    return {
        verifyProvenance(bundle, envelope, expected, signal) {
            return Promise.resolve().then(() => {
                signal.throwIfAborted();
                return answer(byBundle.get(bundle), envelope, expected);
            });
        },
    };
}

function answer(
    attestation: FakeAttestation | undefined,
    envelope: { readonly payloadType: string; readonly payload: Bytes },
    expected: ExpectedWorkflowClaims,
): ProvenanceVerification {
    if (attestation === undefined) return { kind: 'invalid', reason: 'unknown-bundle' };
    if (attestation.payloadType !== envelope.payloadType || !bytesEqual(attestation.payload, envelope.payload)) {
        return { kind: 'invalid', reason: 'payload-mismatch' };
    }
    const claims = checkCertificateClaims(attestation.certificate, expected);
    if (claims.kind === 'mismatch') return { kind: 'invalid', reason: `identity-mismatch:${claims.field}` };
    if (attestation.logIndex === null) return { kind: 'not-in-log', reason: 'no-tlog-entry' };
    const latest = Math.max(...attestation.timestamps.map((time) => time.getTime()));
    return {
        kind: 'verified',
        logIndex: attestation.logIndex,
        trustedTime: attestation.timestamps.length === 0 ? null : new Date(latest),
    };
}
