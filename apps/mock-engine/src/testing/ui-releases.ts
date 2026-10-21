import { createHash } from 'node:crypto';
import { constants, zstdCompressSync } from 'node:zlib';

import { ENGINE_API_VERSION, ENGINE_UI_CSP } from '@ptbk/engine-api';
import type {
    DsseEnvelope,
    ReleaseKind,
    Signer,
    TrustPolicy,
    UiBundleManifest,
    WorkflowIdentity,
} from '@ptbk/protocol';
import {
    DEFAULT_REVOCATION_RULE,
    GITHUB_ACTIONS_ISSUER,
    RELEASE_DELAYS,
    RELEASE_PAYLOAD_TYPE,
    REVOCATION_PAYLOAD_TYPE,
    ReleaseEntry,
    RevocationList,
    SECURITY_THRESHOLD,
    SignedRelease,
    TrustPolicy as TrustPolicySchema,
    UI_BUNDLE_ENTRY,
    UiBundleManifest as UiBundleManifestSchema,
    WorkflowIdentity as WorkflowIdentitySchema,
    createWebCryptoSigner,
    ed25519PublicKeyFromBytes,
    expectedWorkflowClaims,
    generateEd25519KeyPair,
    signDsse,
} from '@ptbk/protocol';
import type { TarFile } from '@ptbk/release-tools';
import { UI_ARCHIVE_MANIFEST_PATH, writeTar } from '@ptbk/release-tools';

import { testProvenanceBundle } from '../adapters/ui/test-provenance';

export { createTestProvenanceVerifier } from '../adapters/ui/test-provenance';

/**
 * Release signing for tests and the e2e stack: keys generated at run time and never written anywhere, archives in
 * the X-03 format, entries and revocation lists as DSSE envelopes, and test attestations in place of Sigstore.
 */

export const TEST_WORKFLOW_IDENTITY: WorkflowIdentity = WorkflowIdentitySchema.parse({
    issuer: GITHUB_ACTIONS_ISSUER,
    repository: 'webgptorg/app',
    repositoryId: '1000001',
    workflowPath: '.github/workflows/ui-release.yml',
});

export const TEST_ARCHIVE_NAME = 'engine-ui.tar.zst';
export const TEST_COMMIT = 'c0ffee'.padEnd(40, '0');

export interface TestReleaseKeys {
    readonly release: Signer;
    /** Three distinct maintainers; a regular release never needs them. */
    readonly maintainers: readonly [Signer, Signer, Signer];
    /** A key no policy trusts. */
    readonly outsider: Signer;
    readonly policy: TrustPolicy;
}

async function newSigner(): Promise<Signer> {
    return createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
}

export async function createTestReleaseKeys(
    identity: WorkflowIdentity = TEST_WORKFLOW_IDENTITY,
): Promise<TestReleaseKeys> {
    const [release, a, b, c, outsider] = await Promise.all(Array.from({ length: 5 }, () => newSigner()));
    if (release === undefined || a === undefined || b === undefined || c === undefined || outsider === undefined) {
        throw new Error('key generation failed');
    }
    const keyRef = (signer: Signer) => ({ publicKey: ed25519PublicKeyFromBytes(signer.publicKey()) });
    const policy = TrustPolicySchema.parse({
        releaseKeys: [keyRef(release)],
        maintainerKeys: [a, b, c].map(keyRef),
        securityThreshold: SECURITY_THRESHOLD,
        workflowIdentity: identity,
        revocationRule: DEFAULT_REVOCATION_RULE,
        delays: RELEASE_DELAYS,
    });
    return { release, maintainers: [a, b, c], outsider, policy };
}

const API_MAJOR = Number(ENGINE_API_VERSION.split('.')[0]);
/** What X-03 writes: every minor of the engine API major the bundle was built against. */
export const ENGINE_API_MAJOR_RANGE = `>=${String(API_MAJOR)}.0.0 <${String(API_MAJOR + 1)}.0.0`;

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const TEST_BUNDLE_FILES: readonly TarFile[] = Object.freeze([
    {
        path: UI_BUNDLE_ENTRY,
        bytes: text(
            '<!doctype html><html><head><script type="module" src="/assets/index-BxD3f9_a.js"></script></head><body></body></html>',
        ),
    },
    { path: 'assets/index-BxD3f9_a.js', bytes: text('document.body.dataset.ui = "test";\n') },
    { path: 'assets/index-Cq8Zt1_x.css', bytes: text('body{margin:0}\n') },
    { path: 'favicon.svg', bytes: text('<svg xmlns="http://www.w3.org/2000/svg"/>') },
]);

export interface TestBundleInput {
    readonly version: string;
    readonly commit?: string;
    readonly files?: readonly TarFile[];
    readonly engineApi?: string;
    readonly csp?: string;
    /** Changes the manifest after it was built from the files (a manifest that does not match its archive). */
    readonly editManifest?: (manifest: UiBundleManifest) => unknown;
    /** Extra archive entries the manifest does not list. */
    readonly unlisted?: readonly TarFile[];
}

export interface TestBundle {
    readonly archive: Uint8Array<ArrayBuffer>;
    readonly sha256: string;
    readonly manifest: UiBundleManifest;
}

/** A UI archive as X-03 packs it: `manifest.json` first, then the files, ustar, zstd. */
export function buildTestBundle(input: TestBundleInput): TestBundle {
    const files = input.files ?? TEST_BUNDLE_FILES;
    const manifest = UiBundleManifestSchema.parse({
        v: 1,
        version: input.version,
        commit: input.commit ?? TEST_COMMIT,
        engineApi: input.engineApi ?? ENGINE_API_MAJOR_RANGE,
        entry: UI_BUNDLE_ENTRY,
        files: files.map((file) => ({ path: file.path, sha256: sha256(file.bytes), size: file.bytes.length })),
        csp: input.csp ?? ENGINE_UI_CSP,
    });
    const manifestJson = input.editManifest === undefined ? manifest : input.editManifest(manifest);
    const tar = writeTar(
        [
            { path: UI_ARCHIVE_MANIFEST_PATH, bytes: text(JSON.stringify(manifestJson)) },
            ...files,
            ...(input.unlisted ?? []),
        ],
        { mtime: 0, first: UI_ARCHIVE_MANIFEST_PATH },
    );
    const archive = new Uint8Array(zstdCompressSync(tar, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }));
    return { archive, sha256: sha256(archive), manifest };
}

export interface TestProvenanceOptions {
    readonly logIndex?: number | null;
    readonly timestamps?: readonly Date[];
    /** Signs for another workflow identity than the policy's. */
    readonly identity?: WorkflowIdentity;
}

export interface TestReleaseInput {
    readonly version: string;
    readonly archiveSha256: string;
    readonly publishedAt: Date;
    readonly commit?: string;
    readonly kind?: ReleaseKind;
    /** Default: the release key alone. */
    readonly signers?: readonly Signer[];
    /** `null`: no provenance at all (an empty bundle text). */
    readonly provenance?: TestProvenanceOptions | null;
    readonly artifacts?: readonly { readonly name: string; readonly sha256: string; readonly kind: 'engine' | 'ui' }[];
    readonly payloadType?: string;
}

/** The exact payload bytes of a release entry. */
export function releasePayload(
    input: Omit<TestReleaseInput, 'signers' | 'provenance' | 'payloadType'>,
): Uint8Array<ArrayBuffer> {
    const entry = ReleaseEntry.parse({
        v: 1,
        version: input.version,
        gitTag: `ui-v${input.version}`,
        commit: input.commit ?? TEST_COMMIT,
        artifacts: input.artifacts ?? [{ name: TEST_ARCHIVE_NAME, sha256: input.archiveSha256, kind: 'ui' }],
        kind: input.kind ?? 'regular',
        advisory: (input.kind ?? 'regular') === 'security' ? 'https://ptbk.test/advisories/1' : null,
        publishedAt: input.publishedAt.toISOString(),
    });
    return text(JSON.stringify(entry));
}

/** A `SignedRelease` JSON value as the store would publish it. */
export async function signTestRelease(keys: TestReleaseKeys, input: TestReleaseInput): Promise<unknown> {
    const payload = releasePayload(input);
    const payloadType = input.payloadType ?? RELEASE_PAYLOAD_TYPE;
    const envelope = await signDsse(input.signers ?? [keys.release], payloadType, payload);
    const options = input.provenance;
    const provenance =
        options === null
            ? 'no provenance'
            : testProvenanceBundle({
                  payloadType,
                  payload,
                  certificate: expectedWorkflowClaims(options?.identity ?? keys.policy.workflowIdentity, {
                      gitTag: `ui-v${input.version}`,
                      commit: input.commit ?? TEST_COMMIT,
                  }),
                  logIndex: options?.logIndex === undefined ? 4242 : options.logIndex,
                  timestamps: options?.timestamps ?? [input.publishedAt],
              });
    return JSON.parse(JSON.stringify(SignedRelease.parse({ v: 1, envelope, provenance }))) as unknown;
}

export interface TestRevocationsInput {
    readonly issuedAt: Date;
    readonly expiresAt: Date;
    readonly revoked?: readonly { readonly version: string; readonly reason: string }[];
    /** Default: the release key. */
    readonly signer?: Signer;
}

/** A revocation list envelope, as the store would publish it. */
export async function signTestRevocations(keys: TestReleaseKeys, input: TestRevocationsInput): Promise<DsseEnvelope> {
    const list = RevocationList.parse({
        v: 1,
        issuedAt: input.issuedAt.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        revoked: input.revoked ?? [],
    });
    return signDsse(input.signer ?? keys.release, REVOCATION_PAYLOAD_TYPE, text(JSON.stringify(list)));
}
