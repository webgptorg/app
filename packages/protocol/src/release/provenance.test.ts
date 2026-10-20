import { describe, expect, it } from 'vitest';
import { releaseTestKeys, testRelease, workflowCertificate, WORKFLOW_IDENTITY } from '../testing/release';
import type { FakeAttestation } from './fake-provenance-verifier';
import { createFakeProvenanceVerifier } from './fake-provenance-verifier';
import type { CertificateClaims, ExpectedWorkflowClaims } from './provenance';
import { FULCIO_OID, checkCertificateClaims, expectedWorkflowClaims } from './provenance';
import vectors from './vectors.json';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TAG = 'ui-v2.0.0';
const SAN = vectors.expectedSubjectAlternativeName;

describe('expectedWorkflowClaims', () => {
    const expected = expectedWorkflowClaims(WORKFLOW_IDENTITY, { gitTag: 'ui-v1.8.2', commit: COMMIT });

    it('pins the SAN, issuer and the four extensions', () => {
        expect(expected.subjectAlternativeName).toBe(SAN);
        expect(expected.issuer).toBe('https://token.actions.githubusercontent.com');
        expect(expected.extensions).toEqual({
            '1.3.6.1.4.1.57264.1.13': COMMIT,
            '1.3.6.1.4.1.57264.1.14': 'refs/tags/ui-v1.8.2',
            '1.3.6.1.4.1.57264.1.15': WORKFLOW_IDENTITY.repositoryId,
            '1.3.6.1.4.1.57264.1.11': 'github-hosted',
            '1.3.6.1.4.1.57264.1.20': 'push',
        });
    });

    it('gives an anchored pattern that matches exactly the SAN, with and without the u flag', () => {
        const pattern = expected.subjectAlternativeNamePattern;
        expect(pattern.startsWith('^')).toBe(true);
        expect(pattern.endsWith('$')).toBe(true);
        for (const regex of [new RegExp(pattern), new RegExp(pattern, 'u')]) {
            expect(regex.test(SAN)).toBe(true);
            for (const other of [
                `${SAN}-evil`,
                `${SAN}/x`,
                `https://evil.example/${SAN}`,
                `x${SAN}`,
                SAN.replace('ui-release.yml', 'ui-releaseXyml'),
                SAN.replace('ui-v1.8.2', 'ui-v1x8x2'),
                SAN.replace('refs/tags/ui-v1.8.2', 'refs/tags/v1.8.2X'),
            ]) {
                expect(regex.test(other)).toBe(false);
            }
        }
    });
});

function alter(
    certificate: CertificateClaims,
    change: { issuer?: string; san?: string; set?: Record<string, string>; remove?: string },
): CertificateClaims {
    const extensions = new Map(certificate.extensions);
    for (const [oid, value] of Object.entries(change.set ?? {})) extensions.set(oid, value);
    if (change.remove !== undefined) extensions.delete(change.remove);
    return {
        issuer: change.issuer ?? certificate.issuer,
        subjectAlternativeName: change.san ?? certificate.subjectAlternativeName,
        extensions,
    };
}

const base = `https://github.com/webgptorg/app/.github/workflows/ui-release.yml@refs/tags/${TAG}`;

describe('identity pinning', () => {
    const genuine = workflowCertificate(TAG);
    const expected = expectedWorkflowClaims(WORKFLOW_IDENTITY, { gitTag: TAG, commit: COMMIT });

    async function verifyWith(certificate: CertificateClaims) {
        const keys = await releaseTestKeys();
        const { release, payload, attestation } = await testRelease({ signers: [keys.release], certificate });
        const verifier = createFakeProvenanceVerifier([attestation]);
        return verifier.verifyProvenance(
            release.provenance,
            { payloadType: release.envelope.payloadType, payload },
            expected,
            new AbortController().signal,
        );
    }

    it('accepts the genuine workflow certificate', async () => {
        expect(genuine.subjectAlternativeName).toBe(base);
        expect(checkCertificateClaims(genuine, expected)).toEqual({ kind: 'match' });
        expect(await verifyWith(genuine)).toEqual({
            kind: 'verified',
            logIndex: 4242,
            trustedTime: new Date('2026-10-01T12:05:00Z'),
        });
    });

    it.each([
        [
            'a workflow_dispatch run',
            { set: { '1.3.6.1.4.1.57264.1.20': 'workflow_dispatch' } },
            '1.3.6.1.4.1.57264.1.20',
        ],
        ['a schedule run', { set: { '1.3.6.1.4.1.57264.1.20': 'schedule' } }, '1.3.6.1.4.1.57264.1.20'],
        ['a missing build trigger', { remove: '1.3.6.1.4.1.57264.1.20' }, '1.3.6.1.4.1.57264.1.20'],
        ['another issuer', { issuer: 'https://token.actions.githubusercontent.com.evil' }, 'issuer'],
        ['another repository', { san: base.replace('webgptorg/app', 'webgptorg/app2') }, 'subjectAlternativeName'],
        ['another workflow path', { san: base.replace('ui-release.yml', 'other.yml') }, 'subjectAlternativeName'],
        ['a SAN that only matches as a prefix', { san: `${base}-rc` }, 'subjectAlternativeName'],
        [
            'a SAN matching only through regex metacharacters',
            { san: base.replace('ui-release.yml', 'ui-releaseXyml') },
            'subjectAlternativeName',
        ],
        [
            'a branch ref in the SAN',
            { san: base.replace(`refs/tags/${TAG}`, 'refs/heads/main') },
            'subjectAlternativeName',
        ],
        [
            'a branch ref',
            { set: { [FULCIO_OID.sourceRepositoryRef]: 'refs/heads/main' } },
            FULCIO_OID.sourceRepositoryRef,
        ],
        [
            'a tag pattern',
            { set: { [FULCIO_OID.sourceRepositoryRef]: 'refs/tags/ui-v*' } },
            FULCIO_OID.sourceRepositoryRef,
        ],
        [
            'another commit',
            { set: { [FULCIO_OID.sourceRepositoryDigest]: `${COMMIT.slice(0, -1)}8` } },
            FULCIO_OID.sourceRepositoryDigest,
        ],
        [
            'another repository ID',
            { set: { [FULCIO_OID.sourceRepositoryIdentifier]: '987654320' } },
            FULCIO_OID.sourceRepositoryIdentifier,
        ],
        [
            'a self-hosted runner',
            { set: { [FULCIO_OID.runnerEnvironment]: 'self-hosted' } },
            FULCIO_OID.runnerEnvironment,
        ],
        ['a missing extension', { remove: FULCIO_OID.runnerEnvironment }, FULCIO_OID.runnerEnvironment],
        [
            'an extension in another case',
            { set: { [FULCIO_OID.runnerEnvironment]: 'GitHub-Hosted' } },
            FULCIO_OID.runnerEnvironment,
        ],
    ] as const)('rejects %s', async (_, change, field) => {
        const certificate = alter(genuine, change);
        expect(checkCertificateClaims(certificate, expected)).toEqual({ kind: 'mismatch', field });
        const result = await verifyWith(certificate);
        expect(result.kind).toBe('invalid');
        expect(result.kind === 'invalid' && result.reason).toBe(`identity-mismatch:${field}`);
    });
});

describe('createFakeProvenanceVerifier', () => {
    const expected: ExpectedWorkflowClaims = expectedWorkflowClaims(WORKFLOW_IDENTITY, { gitTag: TAG, commit: COMMIT });

    async function setup(overrides: Partial<FakeAttestation> = {}) {
        const keys = await releaseTestKeys();
        const { release, payload, attestation } = await testRelease({ signers: [keys.release] });
        const verifier = createFakeProvenanceVerifier([{ ...attestation, ...overrides }]);
        const envelope = { payloadType: release.envelope.payloadType, payload };
        return { verifier, envelope, bundle: release.provenance, payload };
    }

    const signal = () => new AbortController().signal;

    it('refuses a bundle it was not given', async () => {
        const { verifier, envelope, bundle } = await setup();
        expect(await verifier.verifyProvenance(`${bundle} `, envelope, expected, signal())).toEqual({
            kind: 'invalid',
            reason: 'unknown-bundle',
        });
    });

    it('refuses a payload one byte different', async () => {
        const { verifier, envelope, bundle, payload } = await setup();
        const altered = payload.slice();
        altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
        expect(await verifier.verifyProvenance(bundle, { ...envelope, payload: altered }, expected, signal())).toEqual({
            kind: 'invalid',
            reason: 'payload-mismatch',
        });
    });

    it('refuses another payload type', async () => {
        const { verifier, envelope, bundle } = await setup();
        const other = { ...envelope, payloadType: 'application/vnd.ptbk.revocation+json; v=1' };
        expect(await verifier.verifyProvenance(bundle, other, expected, signal())).toEqual({
            kind: 'invalid',
            reason: 'payload-mismatch',
        });
    });

    it('reports a bundle without a log entry as not-in-log', async () => {
        const { verifier, envelope, bundle } = await setup({ logIndex: null });
        expect((await verifier.verifyProvenance(bundle, envelope, expected, signal())).kind).toBe('not-in-log');
    });

    it('returns a null trusted time when the bundle has no timestamp', async () => {
        const { verifier, envelope, bundle } = await setup({ timestamps: [] });
        expect(await verifier.verifyProvenance(bundle, envelope, expected, signal())).toEqual({
            kind: 'verified',
            logIndex: 4242,
            trustedTime: null,
        });
    });

    it.each([
        ['TSA after integrated time', ['2026-10-01T12:00:00Z', '2026-10-01T12:07:00Z']],
        ['integrated time after TSA', ['2026-10-01T12:07:00Z', '2026-10-01T12:00:00Z']],
    ])('uses the latest timestamp (%s)', async (_, times) => {
        const { verifier, envelope, bundle } = await setup({ timestamps: times.map((time) => new Date(time)) });
        const result = await verifier.verifyProvenance(bundle, envelope, expected, signal());
        expect(result.kind === 'verified' && result.trustedTime).toEqual(new Date('2026-10-01T12:07:00Z'));
    });

    it('rejects with an aborted signal', async () => {
        const { verifier, envelope, bundle } = await setup();
        const controller = new AbortController();
        controller.abort();
        await expect(async () =>
            verifier.verifyProvenance(bundle, envelope, expected, controller.signal),
        ).rejects.toThrow('aborted');
    });
});
