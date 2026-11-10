import { ENGINE_API_VERSION, ENGINE_UI_CSP } from '@ptbk/engine-api';
import type {
    DsseEnvelope,
    ReleaseKind,
    ProductionTrustPolicy,
    Signer,
    UiBundleManifest,
    WorkflowIdentity,
} from '@ptbk/protocol';
import {
    DEFAULT_REVOCATION_RULE,
    GITHUB_ACTIONS_ISSUER,
    RELEASE_DELAYS,
    RELEASE_PAYLOAD_TYPE,
    REVOCATION_PAYLOAD_TYPE,
    SECURITY_THRESHOLD,
    ProductionTrustPolicy as ProductionTrustPolicySchema,
    UI_BUNDLE_ENTRY,
    UiBundleManifest as UiBundleManifestSchema,
    WorkflowIdentity as WorkflowIdentitySchema,
    createWebCryptoSigner,
    dsseKeyId,
    ed25519PublicKeyFromBytes,
    encodeBase64Std,
    expectedWorkflowClaims,
    generateEd25519KeyPair,
    pae,
} from '@ptbk/protocol';

import type { ArchiveEntry } from './archive';
import { writeArchiveTar, zstdStore } from './archive';
import type { TestAttestation, TestSigstore } from './sigstore/test-sigstore';
import { ARCHIVE_MANIFEST_PATH } from './store-layout';

/** The release workflow the suite's trust policy pins; every provenance the suite mints claims it unless told not to. */
export const CONFORMANCE_WORKFLOW_IDENTITY: WorkflowIdentity = WorkflowIdentitySchema.parse({
    issuer: GITHUB_ACTIONS_ISSUER,
    repository: 'ptbk-conformance/engine-ui',
    repositoryId: '424242',
    workflowPath: '.github/workflows/ui-release.yml',
});

export const ARCHIVE_NAME = 'engine-ui.tar.zst';
/** The Rekor log index every minted provenance claims; the panel must show it for the active bundle. */
export const RELEASE_LOG_INDEX = 4242;

export interface ReleaseKeys {
    readonly release: Signer;
    readonly maintainers: readonly [Signer, Signer, Signer];
    /** A key no policy trusts. */
    readonly outsider: Signer;
}

async function newSigner(): Promise<Signer> {
    return createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
}

export async function createReleaseKeys(): Promise<ReleaseKeys> {
    const [release, a, b, c, outsider] = await Promise.all(Array.from({ length: 5 }, () => newSigner()));
    if (release === undefined || a === undefined || b === undefined || c === undefined || outsider === undefined) {
        throw new Error('key generation failed');
    }
    return { release, maintainers: [a, b, c], outsider };
}

/** The policy an engine under test trusts: the run's keys, the suite's workflow, the contract's delays. */
export function trustPolicyOf(
    keys: Pick<ReleaseKeys, 'maintainers'> & { readonly releasePublicKeys: readonly Uint8Array[] },
): ProductionTrustPolicy {
    const keyRef = (publicKey: Uint8Array) => ({ publicKey: ed25519PublicKeyFromBytes(publicKey) });
    return ProductionTrustPolicySchema.parse({
        releaseKeys: keys.releasePublicKeys.map(keyRef),
        maintainerKeys: keys.maintainers.map((signer) => keyRef(signer.publicKey())),
        securityThreshold: SECURITY_THRESHOLD,
        workflowIdentity: CONFORMANCE_WORKFLOW_IDENTITY,
        revocationRule: DEFAULT_REVOCATION_RULE,
        delays: RELEASE_DELAYS,
    });
}

const API_MAJOR = Number(ENGINE_API_VERSION.split('.')[0]);
export const ENGINE_API_MAJOR_RANGE = `>=${String(API_MAJOR)}.0.0 <${String(API_MAJOR + 1)}.0.0`;

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A commit hash per version, so a manifest from one release never matches another's entry by accident. */
export function commitOf(version: string): string {
    const hex = Array.from(text(version), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `c0de${hex}`.padEnd(40, '0').slice(0, 40);
}

export interface BundleFile {
    readonly path: string;
    readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * A bundle's files: the entry names its version in a marker the suite looks for in what the engine serves, and the
 * hashed asset names look like Vite's, so the engine's immutable caching applies to them.
 */
export function bundleFiles(version: string): readonly BundleFile[] {
    const tag = version.replace(/[^0-9A-Za-z]/g, '_');
    return [
        {
            path: UI_BUNDLE_ENTRY,
            bytes: text(
                `<!doctype html><html><head><meta name="ptbk-conformance-ui" content="${version}"><script type="module" src="/assets/index-${tag}.js"></script><link rel="stylesheet" href="/assets/index-${tag}.css"></head><body></body></html>`,
            ),
        },
        { path: `assets/index-${tag}.js`, bytes: text(`document.body.dataset.ui = ${JSON.stringify(version)};\n`) },
        { path: `assets/index-${tag}.css`, bytes: text('body{margin:0}\n') },
        { path: 'favicon.svg', bytes: text('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    ];
}

export interface BundleSpec {
    readonly version: string;
    readonly commit?: string;
    readonly engineApi?: string;
    readonly csp?: string;
    /** Edits the manifest after it was built from the files. */
    readonly editManifest?: (manifest: UiBundleManifest) => unknown;
    /** Edits the archive's entries (manifest first) before they are written. */
    readonly editEntries?: (entries: ArchiveEntry[]) => ArchiveEntry[];
}

export interface Bundle {
    readonly version: string;
    readonly archive: Uint8Array<ArrayBuffer>;
    readonly sha256: string;
    readonly manifest: UiBundleManifest;
    readonly files: readonly BundleFile[];
}

/** A UI archive as X-03 packs it: ustar, `manifest.json` first, zstd. */
export async function buildBundle(spec: BundleSpec): Promise<Bundle> {
    const files = bundleFiles(spec.version);
    const manifest = UiBundleManifestSchema.parse({
        v: 1,
        version: spec.version,
        commit: spec.commit ?? commitOf(spec.version),
        engineApi: spec.engineApi ?? ENGINE_API_MAJOR_RANGE,
        entry: UI_BUNDLE_ENTRY,
        files: await Promise.all(
            files.map(async (file) => ({
                path: file.path,
                sha256: await sha256Hex(file.bytes),
                size: file.bytes.length,
            })),
        ),
        csp: spec.csp ?? ENGINE_UI_CSP,
    });
    const manifestJson = spec.editManifest === undefined ? manifest : spec.editManifest(manifest);
    const entries: ArchiveEntry[] = [
        { kind: 'file', path: ARCHIVE_MANIFEST_PATH, bytes: text(JSON.stringify(manifestJson)) },
        { kind: 'directory', path: 'assets/' },
        ...files.map((file): ArchiveEntry => ({ kind: 'file', path: file.path, bytes: file.bytes })),
    ];
    const archive = zstdStore(writeArchiveTar(spec.editEntries === undefined ? entries : spec.editEntries(entries)));
    return { version: spec.version, archive, sha256: await sha256Hex(archive), manifest, files };
}

export interface EntrySpec {
    readonly version: string;
    readonly archiveSha256: string;
    readonly publishedAt: Date;
    readonly commit?: string;
    readonly kind?: ReleaseKind;
}

/** The release entry as an object, in the field order X-03 writes. */
export function releaseEntry(spec: EntrySpec): Record<string, unknown> {
    const kind = spec.kind ?? 'regular';
    return {
        v: 1,
        version: spec.version,
        gitTag: `ui-v${spec.version}`,
        commit: spec.commit ?? commitOf(spec.version),
        artifacts: [{ name: ARCHIVE_NAME, sha256: spec.archiveSha256, kind: 'ui' }],
        kind,
        advisory: kind === 'security' ? 'https://advisories.conformance.invalid/1' : null,
        publishedAt: spec.publishedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
}

/** Who the provenance claims built the release, and how its bundle is made; defaults are the genuine release. */
export interface ProvenanceSpec {
    readonly identity?: WorkflowIdentity;
    /** The tag and commit the certificate claims; default the entry's. */
    readonly gitTag?: string;
    readonly commit?: string;
    readonly editClaims?: (claims: TestAttestation['certificate']) => TestAttestation['certificate'];
    readonly integratedTime?: Date;
    readonly options?: Pick<
        TestAttestation,
        'extensionEncoding' | 'omitTlogEntry' | 'omitInclusionPromise' | 'omitSct' | 'untrustedCa'
    >;
    /** RFC 3161 timestamps besides the log's integrated time. */
    readonly tsaTimes?: readonly Date[];
    /** Attests these bytes and type instead of the envelope's. */
    readonly payload?: Uint8Array;
    readonly payloadType?: string;
}

export interface ReleaseSpec {
    readonly entry: EntrySpec;
    /** Exact payload text; default `JSON.stringify` of the entry. */
    readonly payloadText?: (entry: Record<string, unknown>) => string;
    readonly payloadType?: string;
    /** Default: the release key alone. */
    readonly signers?: readonly Signer[];
    /** Signs these bytes instead of the PAE (a raw-payload signature, for instance). */
    readonly signedBytes?: (pae: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
    /** Replaces the payload after signing. */
    readonly tamperPayload?: (payload: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
    /** `null` publishes an empty bundle (`{}`) where the provenance belongs. */
    readonly provenance?: ProvenanceSpec | null;
}

export interface Minted {
    readonly sigstore: TestSigstore;
    readonly keys: ReleaseKeys;
}

/** A `SignedRelease` JSON text as the store publishes it. */
export async function signRelease(minted: Minted, spec: ReleaseSpec): Promise<string> {
    const entry = releaseEntry(spec.entry);
    const signedPayload = text(spec.payloadText === undefined ? JSON.stringify(entry) : spec.payloadText(entry));
    const payloadType = spec.payloadType ?? RELEASE_PAYLOAD_TYPE;
    const message = pae(payloadType, signedPayload);
    const signers = spec.signers ?? [minted.keys.release];
    const signatures = await Promise.all(
        signers.map(async (signer) => ({
            keyid: await dsseKeyId(signer.publicKey()),
            sig: encodeBase64Std(
                await signer.sign(spec.signedBytes === undefined ? message : spec.signedBytes(message, signedPayload)),
            ),
        })),
    );
    const payload = spec.tamperPayload === undefined ? signedPayload : spec.tamperPayload(signedPayload);
    const envelope: DsseEnvelope = { payloadType, payload: encodeBase64Std(payload), signatures };
    const provenance =
        spec.provenance === null
            ? '{}'
            : await mintProvenance(minted.sigstore, spec.provenance ?? {}, {
                  payloadType,
                  payload,
                  gitTag: `ui-v${spec.entry.version}`,
                  commit: spec.entry.commit ?? commitOf(spec.entry.version),
                  integratedTime: spec.entry.publishedAt,
              });
    return JSON.stringify({ v: 1, envelope, provenance });
}

async function mintProvenance(
    sigstore: TestSigstore,
    spec: ProvenanceSpec,
    defaults: {
        readonly payloadType: string;
        readonly payload: Uint8Array;
        readonly gitTag: string;
        readonly commit: string;
        readonly integratedTime: Date;
    },
): Promise<string> {
    const claims = expectedWorkflowClaims(spec.identity ?? CONFORMANCE_WORKFLOW_IDENTITY, {
        gitTag: spec.gitTag ?? defaults.gitTag,
        commit: spec.commit ?? defaults.commit,
    });
    const certificate: TestAttestation['certificate'] = {
        issuer: claims.issuer,
        subjectAlternativeName: claims.subjectAlternativeName,
        extensions: { ...claims.extensions },
    };
    return sigstore.attest({
        payloadType: spec.payloadType ?? defaults.payloadType,
        payload: spec.payload ?? defaults.payload,
        certificate: spec.editClaims === undefined ? certificate : spec.editClaims(certificate),
        integratedTime: spec.integratedTime ?? defaults.integratedTime,
        logIndex: RELEASE_LOG_INDEX,
        ...(spec.tsaTimes === undefined ? {} : { tsaTimes: spec.tsaTimes }),
        ...spec.options,
    });
}

export interface RevocationSpec {
    readonly issuedAt: Date;
    readonly expiresAt: Date;
    readonly revoked?: readonly string[];
    /** Default: the release key. */
    readonly signer?: Signer;
}

/** A revocation list envelope's JSON text, as the store publishes it. */
export async function signRevocations(keys: ReleaseKeys, spec: RevocationSpec): Promise<string> {
    const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const payload = text(
        JSON.stringify({
            v: 1,
            issuedAt: iso(spec.issuedAt),
            expiresAt: iso(spec.expiresAt),
            revoked: (spec.revoked ?? []).map((version) => ({ version, reason: 'conformance check' })),
        }),
    );
    const signer = spec.signer ?? keys.release;
    const envelope: DsseEnvelope = {
        payloadType: REVOCATION_PAYLOAD_TYPE,
        payload: encodeBase64Std(payload),
        signatures: [
            {
                keyid: await dsseKeyId(signer.publicKey()),
                sig: encodeBase64Std(await signer.sign(pae(REVOCATION_PAYLOAD_TYPE, payload))),
            },
        ],
    };
    return JSON.stringify(envelope);
}
