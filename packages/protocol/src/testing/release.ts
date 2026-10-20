import { utf8Encode } from '../bytes';
import type { Bytes } from '../bytes';
import type { Signer } from '../ed25519';
import { createWebCryptoSigner, importEd25519PrivateKey } from '../ed25519';
import { ed25519PublicKeyFromBytes } from '../ids';
import type { DsseEnvelope } from '../release/dsse';
import { RELEASE_PAYLOAD_TYPE, REVOCATION_PAYLOAD_TYPE, signDsse } from '../release/dsse';
import type { FakeAttestation } from '../release/fake-provenance-verifier';
import type { CertificateClaims } from '../release/provenance';
import { FULCIO_OID } from '../release/provenance';
import type { TrustPolicy, WorkflowIdentity } from '../release/trust';
import { DEFAULT_REVOCATION_RULE, RELEASE_DELAYS, TrustPolicy as TrustPolicySchema } from '../release/trust';
import vectors from '../release/vectors.json';
import { fromHex } from './hex';

export interface ReleaseTestKeys {
    readonly release: Signer;
    readonly maintainers: readonly [Signer, Signer, Signer];
    readonly outsider: Signer;
}

async function signerFor(role: string): Promise<Signer> {
    const key = vectors.keys.find((candidate) => candidate.role === role);
    if (key === undefined) throw new Error(`no vector key ${role}`);
    return createWebCryptoSigner(await importEd25519PrivateKey(fromHex(key.seedHex), { extractable: false }));
}

/** The RFC 8032 test keys of `src/release/vectors.json`. */
export async function releaseTestKeys(): Promise<ReleaseTestKeys> {
    const [release, m1, m2, m3, outsider] = await Promise.all(
        ['release', 'maintainer-1', 'maintainer-2', 'maintainer-3', 'outsider'].map(signerFor),
    );
    if (!release || !m1 || !m2 || !m3 || !outsider) throw new Error('missing vector keys');
    return { release, maintainers: [m1, m2, m3], outsider };
}

export const WORKFLOW_IDENTITY: WorkflowIdentity = vectors.workflowIdentity as WorkflowIdentity;

export function testPolicy(keys: ReleaseTestKeys, overrides: Partial<TrustPolicy> = {}): TrustPolicy {
    return TrustPolicySchema.parse({
        releaseKeys: [{ publicKey: ed25519PublicKeyFromBytes(keys.release.publicKey()) }],
        maintainerKeys: keys.maintainers.map((signer) => ({
            publicKey: ed25519PublicKeyFromBytes(signer.publicKey()),
        })),
        securityThreshold: 2,
        workflowIdentity: WORKFLOW_IDENTITY,
        revocationRule: DEFAULT_REVOCATION_RULE,
        delays: RELEASE_DELAYS,
        ...overrides,
    });
}

export const COMMIT = '0123456789abcdef0123456789abcdef01234567';
export const ARTIFACT_SHA256 = vectors.artifact.sha256;

export interface EntryFields {
    readonly v?: unknown;
    readonly version?: string;
    readonly gitTag?: string;
    readonly commit?: string;
    readonly artifacts?: unknown;
    readonly kind?: 'regular' | 'security';
    readonly advisory?: string | null;
    readonly publishedAt?: string;
}

/** Entry JSON with sensible defaults (a regular 2.0.0 UI release published 2026-10-01T12:00:00Z). */
export function entryJson(fields: EntryFields = {}): Record<string, unknown> {
    const kind = fields.kind ?? 'regular';
    return {
        v: 1,
        version: '2.0.0',
        gitTag: 'ui-v2.0.0',
        commit: COMMIT,
        artifacts: [{ name: 'engine-ui.tar.zst', sha256: ARTIFACT_SHA256, kind: 'ui' }],
        kind,
        advisory: kind === 'security' ? 'https://ptbk.io/security/2026-002' : null,
        publishedAt: '2026-10-01T12:00:00Z',
        ...fields,
    };
}

/** The certificate a genuine run of the release workflow for this tag and commit would carry. */
export function workflowCertificate(
    gitTag: string,
    commit: string = COMMIT,
    identity: WorkflowIdentity = WORKFLOW_IDENTITY,
): CertificateClaims {
    return {
        issuer: identity.issuer,
        subjectAlternativeName: `https://github.com/${identity.repository}/${identity.workflowPath}@refs/tags/${gitTag}`,
        extensions: new Map([
            [FULCIO_OID.runnerEnvironment, 'github-hosted'],
            [FULCIO_OID.sourceRepositoryDigest, commit],
            [FULCIO_OID.sourceRepositoryRef, `refs/tags/${gitTag}`],
            [FULCIO_OID.sourceRepositoryIdentifier, identity.repositoryId],
            [FULCIO_OID.buildTrigger, 'push'],
        ]),
    };
}

export interface TestRelease {
    /** The `SignedRelease` JSON value. */
    readonly release: { readonly v: 1; readonly envelope: DsseEnvelope; readonly provenance: string };
    readonly payload: Bytes;
    readonly attestation: FakeAttestation;
}

export interface TestReleaseOptions {
    readonly signers: readonly Signer[];
    readonly entry?: Record<string, unknown>;
    /** Exact payload text, overriding `entry`. */
    readonly payloadText?: string;
    readonly payloadType?: string;
    readonly certificate?: CertificateClaims;
    readonly logIndex?: number | null;
    readonly timestamps?: readonly Date[];
    readonly bundle?: string;
}

/** A signed release and the matching fake attestation (trusted time 2026-10-01T12:05:00Z unless overridden). */
export async function testRelease(options: TestReleaseOptions): Promise<TestRelease> {
    const entry = options.entry ?? entryJson();
    const payload = utf8Encode(options.payloadText ?? JSON.stringify(entry));
    const payloadType = options.payloadType ?? RELEASE_PAYLOAD_TYPE;
    const envelope = await signDsse(options.signers, payloadType, payload);
    const bundle = options.bundle ?? `{"fake-bundle":"${String(entry['version'])}"}`;
    const gitTag = typeof entry['gitTag'] === 'string' ? entry['gitTag'] : '';
    const commit = typeof entry['commit'] === 'string' ? entry['commit'] : COMMIT;
    return {
        release: { v: 1, envelope, provenance: bundle },
        payload,
        attestation: {
            bundle,
            payloadType,
            payload,
            certificate: options.certificate ?? workflowCertificate(gitTag, commit),
            logIndex: options.logIndex === undefined ? 4242 : options.logIndex,
            timestamps: options.timestamps ?? [new Date('2026-10-01T12:05:00Z')],
        },
    };
}

export interface RevocationOptions {
    readonly signers: readonly Signer[];
    readonly issuedAt?: string;
    readonly expiresAt?: string;
    readonly revoked?: readonly { readonly version: string; readonly reason: string }[];
}

/** A signed revocation list, by default issued 2026-10-02 and valid for 30 days, revoking nothing. */
export async function testRevocations(options: RevocationOptions): Promise<DsseEnvelope> {
    const list = {
        v: 1,
        issuedAt: options.issuedAt ?? '2026-10-02T00:00:00Z',
        expiresAt: options.expiresAt ?? '2026-11-01T00:00:00Z',
        revoked: options.revoked ?? [],
    };
    return signDsse(options.signers, REVOCATION_PAYLOAD_TYPE, utf8Encode(JSON.stringify(list)));
}
