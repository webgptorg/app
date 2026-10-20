import type { Bytes } from '../bytes';
import type { ReleaseEntry } from './entry';
import type { WorkflowIdentity } from './trust';

/** The Fulcio certificate extensions every release attestation must carry, decoded as UTF-8 strings. */
export const FULCIO_OID = Object.freeze({
    runnerEnvironment: '1.3.6.1.4.1.57264.1.11',
    sourceRepositoryDigest: '1.3.6.1.4.1.57264.1.13',
    sourceRepositoryRef: '1.3.6.1.4.1.57264.1.14',
    sourceRepositoryIdentifier: '1.3.6.1.4.1.57264.1.15',
    buildTrigger: '1.3.6.1.4.1.57264.1.20',
} as const);
export type FulcioOid = (typeof FULCIO_OID)[keyof typeof FULCIO_OID];

export const GITHUB_HOSTED_RUNNER = 'github-hosted';
/** Only a tag push may release; a `workflow_dispatch` run of the same workflow is a dry run (decided 2026-10-20). */
export const RELEASE_BUILD_TRIGGER = 'push';

export interface ExpectedWorkflowClaims {
    readonly issuer: string;
    /** Compared with string equality. */
    readonly subjectAlternativeName: string;
    /**
     * `^…$` with every metacharacter escaped, for APIs that only accept a JavaScript `RegExp` source. Prefer
     * `subjectAlternativeName` and exact equality wherever the API allows it.
     */
    readonly subjectAlternativeNamePattern: string;
    readonly extensions: Readonly<Record<FulcioOid, string>>;
}

// Only syntax characters and `/`, the escapes valid with and without the `u` flag.
function escapeRegExp(text: string): string {
    return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** The exact certificate claims of the release workflow run that built `entry` (pure). */
export function expectedWorkflowClaims(
    identity: WorkflowIdentity,
    entry: Pick<ReleaseEntry, 'gitTag' | 'commit'>,
): ExpectedWorkflowClaims {
    const ref = `refs/tags/${entry.gitTag}`;
    const subjectAlternativeName = `https://github.com/${identity.repository}/${identity.workflowPath}@${ref}`;
    return Object.freeze({
        issuer: identity.issuer,
        subjectAlternativeName,
        subjectAlternativeNamePattern: `^${escapeRegExp(subjectAlternativeName)}$`,
        extensions: Object.freeze({
            [FULCIO_OID.sourceRepositoryDigest]: entry.commit,
            [FULCIO_OID.sourceRepositoryRef]: ref,
            [FULCIO_OID.sourceRepositoryIdentifier]: identity.repositoryId,
            [FULCIO_OID.runnerEnvironment]: GITHUB_HOSTED_RUNNER,
            [FULCIO_OID.buildTrigger]: RELEASE_BUILD_TRIGGER,
        }),
    });
}

/** What an adapter read from a verified signing certificate; extension values already DER-decoded to strings. */
export interface CertificateClaims {
    readonly issuer: string;
    readonly subjectAlternativeName: string;
    readonly extensions: ReadonlyMap<string, string>;
}

export type CertificateClaimsCheck =
    | { readonly kind: 'match' }
    | { readonly kind: 'mismatch'; readonly field: 'issuer' | 'subjectAlternativeName' | FulcioOid };

/** Exact string equality on every expected claim; never a pattern, prefix or case-insensitive match. */
export function checkCertificateClaims(
    claims: CertificateClaims,
    expected: ExpectedWorkflowClaims,
): CertificateClaimsCheck {
    if (claims.issuer !== expected.issuer) return { kind: 'mismatch', field: 'issuer' };
    if (claims.subjectAlternativeName !== expected.subjectAlternativeName) {
        return { kind: 'mismatch', field: 'subjectAlternativeName' };
    }
    for (const oid of Object.values(FULCIO_OID)) {
        if (claims.extensions.get(oid) !== expected.extensions[oid]) return { kind: 'mismatch', field: oid };
    }
    return { kind: 'match' };
}

export type ProvenanceVerification =
    | { readonly kind: 'verified'; readonly logIndex: number; readonly trustedTime: Date | null }
    | { readonly kind: 'invalid'; readonly reason: string }
    | { readonly kind: 'not-in-log'; readonly reason: string };

/**
 * Verifies the Sigstore bundle of a release. Every adapter must: require the bundle's DSSE payload type and payload to
 * equal `envelope` byte for byte; match the certificate against `expected` exactly (`checkCertificateClaims`, never a
 * caller-supplied pattern); require at least one transparency log entry; verify against a pinned `trusted_root.json`
 * without a live TUF fetch; and return as `trustedTime` the latest verified timestamp (RFC 3161 TSA or Rekor v1
 * integrated time), `null` when there is none. A malformed or unverifiable bundle is `invalid`, never a rejection:
 * the promise rejects only on abort or broken infrastructure. `reason` is diagnostic only and never contains bundle
 * content.
 */
export interface ProvenanceVerifier {
    verifyProvenance(
        bundle: string,
        envelope: { readonly payloadType: string; readonly payload: Bytes },
        expected: ExpectedWorkflowClaims,
        signal: AbortSignal,
    ): Promise<ProvenanceVerification>;
}
