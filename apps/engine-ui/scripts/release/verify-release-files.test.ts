import type { DsseEnvelope, FakeAttestation, ReleaseEntry, TrustPolicy, WorkflowIdentity } from '@ptbk/protocol';
import {
    DEFAULT_REVOCATION_RULE,
    GITHUB_ACTIONS_ISSUER,
    RELEASE_DELAYS,
    RELEASE_PAYLOAD_TYPE,
    REVOCATION_PAYLOAD_TYPE,
    SECURITY_THRESHOLD,
    createFakeProvenanceVerifier,
    createFixedClock,
    createWebCryptoSigner,
    decodeBase64Std,
    ed25519PublicKeyFromBytes,
    encodeBase64Std,
    encodeBase64Url,
    expectedWorkflowClaims,
    importEd25519PrivateKey,
    signDsse,
} from '@ptbk/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import { compressArchive, packBundle } from './archive.ts';
import { MANIFEST_PATH, buildManifest, sha256Hex } from './manifest.ts';
import { buildReleasePayload } from './release-entry.ts';
import { signRelease } from './signed-release.ts';
import { writeTar } from './tar.ts';
import type { ReleaseFiles } from './verify-release-files.ts';
import { verifyReleaseFiles } from './verify-release-files.ts';

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const NOW = new Date('2026-10-20T12:00:00.000Z');
const COMMIT = 'd'.repeat(40);
const TAG = 'ui-v0.1.0';
const IDENTITY: WorkflowIdentity = {
    issuer: GITHUB_ACTIONS_ISSUER,
    repository: 'webgptorg/app',
    repositoryId: '1411959168',
    workflowPath: '.github/workflows/ui-release.yml',
};
const DIST = [
    { path: 'index.html', bytes: text('<!doctype html>') },
    { path: 'assets/index-BxD3f9_a.js', bytes: text('console.log(1)') },
];

const seedOf = (byte: number): string => encodeBase64Url(new Uint8Array(32).fill(byte));
const RELEASE_SEED = seedOf(1);
const OTHER_SEED = seedOf(9);

async function publicKeyOf(seed: number) {
    const signer = await createWebCryptoSigner(
        await importEd25519PrivateKey(new Uint8Array(32).fill(seed), { extractable: false }),
    );
    return ed25519PublicKeyFromBytes(signer.publicKey());
}

let policy: TrustPolicy;
beforeAll(async () => {
    policy = {
        releaseKeys: [{ publicKey: await publicKeyOf(1) }],
        maintainerKeys: [
            { publicKey: await publicKeyOf(2) },
            { publicKey: await publicKeyOf(3) },
            { publicKey: await publicKeyOf(4) },
        ],
        securityThreshold: SECURITY_THRESHOLD,
        workflowIdentity: IDENTITY,
        revocationRule: DEFAULT_REVOCATION_RULE,
        delays: { regularMs: RELEASE_DELAYS.regularMs, securityMs: RELEASE_DELAYS.securityMs },
    };
});

const PROVENANCE = '{"fake":"sigstore bundle"}';

function attestation(
    payload: Uint8Array<ArrayBuffer>,
    entry: Pick<ReleaseEntry, 'gitTag' | 'commit'>,
    logged = true,
): FakeAttestation {
    const expected = expectedWorkflowClaims(IDENTITY, entry);
    return {
        bundle: PROVENANCE,
        payloadType: RELEASE_PAYLOAD_TYPE,
        payload,
        certificate: {
            issuer: expected.issuer,
            subjectAlternativeName: expected.subjectAlternativeName,
            extensions: new Map(Object.entries(expected.extensions)),
        },
        logIndex: logged ? 42 : null,
        timestamps: [new Date('2026-10-20T11:59:00.000Z')],
    };
}

interface Release {
    readonly files: ReleaseFiles;
    readonly payload: Uint8Array<ArrayBuffer>;
}

async function release(
    options: {
        archive?: Uint8Array<ArrayBuffer>;
        manifestBytes?: Uint8Array<ArrayBuffer>;
        payload?: Uint8Array<ArrayBuffer>;
        seed?: string;
    } = {},
): Promise<Release> {
    const packed = packBundle({
        version: '0.1.0',
        commit: COMMIT,
        engineApiVersion: '1.1.0',
        csp: '',
        files: DIST,
        mtime: 1_760_000_000,
    });
    const archive = options.archive ?? packed.archive;
    const payload =
        options.payload ??
        buildReleasePayload({
            version: '0.1.0',
            gitTag: TAG,
            commit: COMMIT,
            archiveSha256: sha256Hex(archive),
            publishedAt: NOW,
        });
    const signed = await signRelease({
        payload,
        provenance: PROVENANCE,
        seed: options.seed ?? RELEASE_SEED,
        policy: options.seed === undefined ? policy : { ...policy, releaseKeys: [{ publicKey: await publicKeyOf(9) }] },
    });
    return {
        payload,
        files: {
            release: JSON.parse(JSON.stringify(signed)),
            archive,
            manifestBytes: options.manifestBytes ?? packed.manifestBytes,
            revocations: null,
        },
    };
}

function deps(attestations: readonly FakeAttestation[], trust: TrustPolicy = policy) {
    return { policy: trust, provenance: createFakeProvenanceVerifier(attestations), clock: createFixedClock(NOW) };
}

async function check(r: Release, change: Partial<ReleaseFiles> = {}, trust?: TrustPolicy, logged = true) {
    return verifyReleaseFiles(
        { ...r.files, ...change },
        deps([attestation(r.payload, { gitTag: TAG, commit: COMMIT }, logged)], trust),
    );
}

async function revocationList(
    revoked: readonly string[],
    expiresAt = '2026-11-01T00:00:00.000Z',
): Promise<DsseEnvelope> {
    const signer = await createWebCryptoSigner(
        await importEd25519PrivateKey(new Uint8Array(32).fill(1), { extractable: false }),
    );
    const list = {
        v: 1,
        issuedAt: '2026-10-20T00:00:00.000Z',
        expiresAt,
        revoked: revoked.map((version) => ({ version, reason: 'test' })),
    };
    return signDsse(signer, REVOCATION_PAYLOAD_TYPE, text(JSON.stringify(list)));
}

describe('verifyReleaseFiles', () => {
    it('accepts a release with the staging release-key signature and provenance', async () => {
        const result = await check(await release());
        expect(result).toMatchObject({ kind: 'ok', revocations: 'not-supplied', entry: { version: '0.1.0' } });
    });

    it('checks a supplied revocation list and refuses a revoked version', async () => {
        const r = await release();
        expect(await check(r, { revocations: await revocationList([]) })).toMatchObject({
            kind: 'ok',
            revocations: 'checked',
        });
        expect(await check(r, { revocations: await revocationList(['0.1.0']) })).toEqual({
            kind: 'refused',
            reason: 'revoked',
        });
        expect(await check(r, { revocations: await revocationList([], '2026-10-20T06:00:00.000Z') })).toEqual({
            kind: 'refused',
            reason: 'revocations-unverifiable: expired',
        });
    });

    it('refuses an entry without the release-key signature', async () => {
        const result = await check(await release({ seed: OTHER_SEED }));
        expect(result).toEqual({ kind: 'refused', reason: 'signature-threshold-not-met: trusted-key' });
    });

    it('refuses an entry without valid provenance', async () => {
        const r = await release();
        const result = await verifyReleaseFiles(r.files, deps([]));
        expect(result).toEqual({ kind: 'refused', reason: 'signature-threshold-not-met: provenance' });
    });

    it('refuses provenance without a log entry', async () => {
        expect(await check(await release(), {}, policy, false)).toEqual({ kind: 'refused', reason: 'not-in-log' });
    });

    it.each([
        ['repository', { repository: 'webgptorg/other' }],
        ['repository ID', { repositoryId: '1' }],
        ['workflow path', { workflowPath: '.github/workflows/ci.yml' }],
    ])('refuses when the trust policy names another %s', async (_case, change) => {
        const r = await release();
        const other = { ...policy, workflowIdentity: { ...IDENTITY, ...change } };
        expect(await check(r, {}, other)).toEqual({
            kind: 'refused',
            reason: 'signature-threshold-not-met: provenance',
        });
    });

    it('refuses an archive with one byte changed', async () => {
        const r = await release();
        const archive = r.files.archive.slice();
        archive[archive.length - 1] = (archive[archive.length - 1] ?? 0) ^ 1;
        expect(await check(r, { archive })).toEqual({ kind: 'refused', reason: 'archive hash-mismatch' });
    });

    it('refuses a payload with one byte changed', async () => {
        const r = await release();
        const signed = r.files.release as { envelope: DsseEnvelope };
        const decoded = decodeBase64Std(signed.envelope.payload);
        if (decoded.kind !== 'ok') throw new Error('fixture');
        const payload = decoded.bytes.slice();
        payload[payload.length - 3] = (payload[payload.length - 3] ?? 0) ^ 1;
        const tampered = { ...signed, envelope: { ...signed.envelope, payload: encodeBase64Std(payload) } };
        expect(await check(r, { release: tampered })).toEqual({
            kind: 'refused',
            reason: 'signature-threshold-not-met: trusted-key',
        });
    });

    it('refuses a published manifest with one hash changed', async () => {
        const r = await release();
        const manifest = JSON.parse(new TextDecoder().decode(r.files.manifestBytes)) as { files: { sha256: string }[] };
        const first = manifest.files[0];
        if (first === undefined) throw new Error('fixture');
        first.sha256 = `${first.sha256.slice(0, -1)}${first.sha256.endsWith('0') ? '1' : '0'}`;
        const manifestBytes = text(`${JSON.stringify(manifest, null, 2)}\n`);
        expect(JSON.stringify(await check(r, { manifestBytes }))).toMatch(/manifest.json differs/);
    });

    it('refuses a signed archive whose manifest does not match its files', async () => {
        const manifest = buildManifest({
            version: '0.1.0',
            commit: COMMIT,
            engineApiVersion: '1.1.0',
            csp: '',
            files: DIST,
        });
        const lying = { ...manifest, files: manifest.files.map((file) => ({ ...file, sha256: '0'.repeat(64) })) };
        const manifestBytes = text(`${JSON.stringify(lying, null, 2)}\n`);
        const archive = compressArchive(
            writeTar([{ path: MANIFEST_PATH, bytes: manifestBytes }, ...DIST], { mtime: 0, first: MANIFEST_PATH }),
        );
        const result = await check(await release({ archive, manifestBytes }));
        expect(result).toEqual({ kind: 'refused', reason: 'hash-mismatch: assets/index-BxD3f9_a.js' });
    });

    it('refuses a signed archive that does not unpack', async () => {
        const result = await check(await release({ archive: text('not an archive') }));
        expect(JSON.stringify(result)).toMatch(/does not unpack/);
    });

    it('refuses a manifest for another version than the entry', async () => {
        const packed = packBundle({
            version: '0.2.0',
            commit: COMMIT,
            engineApiVersion: '1.1.0',
            csp: '',
            files: DIST,
            mtime: 0,
        });
        const result = await check(await release({ archive: packed.archive, manifestBytes: packed.manifestBytes }));
        expect(JSON.stringify(result)).toMatch(/another version or commit/);
    });

    it('refuses an entry that is not a single ui artifact', async () => {
        const entry = {
            v: 1,
            version: '0.1.0',
            gitTag: TAG,
            commit: COMMIT,
            artifacts: [
                { name: 'engine-ui.tar.zst', sha256: '0'.repeat(64), kind: 'ui' },
                { name: 'engine.tar.gz', sha256: '1'.repeat(64), kind: 'engine' },
            ],
            kind: 'regular',
            advisory: null,
            publishedAt: NOW.toISOString(),
        };
        const result = await check(await release({ payload: text(JSON.stringify(entry)) }));
        expect(JSON.stringify(result)).toMatch(/exactly one ui artifact/);
    });

    it('refuses a signed payload that is not a release entry', async () => {
        const result = await check(await release({ payload: text('{"v":2}') }));
        expect(result).toEqual({ kind: 'refused', reason: 'invalid-entry' });
    });
});
