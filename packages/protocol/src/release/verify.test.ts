import { beforeAll, describe, expect, it } from 'vitest';
import { encodeBase64Std } from '../base64std';
import { utf8Encode } from '../bytes';
import { createFixedClock } from '../clock';
import { EngineVersion, ed25519PublicKeyFromBytes } from '../ids';
import type { ReleaseTestKeys, TestRelease, TestReleaseOptions } from '../testing/release';
import { entryJson, releaseTestKeys, testPolicy, testRelease, testRevocations } from '../testing/release';
import { RELEASE_PAYLOAD_TYPE, REVOCATION_PAYLOAD_TYPE, signDsse } from './dsse';
import { REVOCATION_MAX_FUTURE_SKEW_MS } from './revocation';
import type { DsseEnvelope } from './dsse';
import type { FakeAttestation } from './fake-provenance-verifier';
import { createFakeProvenanceVerifier } from './fake-provenance-verifier';
import type { ProvenanceVerifier } from './provenance';
import type { TrustPolicy } from './trust';
import type { ReleaseVerification, VerifyReleaseInput } from './verify';
import { verifyRelease } from './verify';
import vectors from './vectors.json';

const HOUR = 60 * 60 * 1000;
const TRUSTED_TIME = new Date('2026-10-01T12:05:00Z');
const FIRST_SEEN = new Date('2026-10-01T12:10:00Z');
const NOW = new Date('2026-10-10T00:00:00Z');

let keys: ReleaseTestKeys;
let policy: TrustPolicy;
let revocations: DsseEnvelope;

beforeAll(async () => {
    keys = await releaseTestKeys();
    policy = testPolicy(keys);
    revocations = await testRevocations({ signers: [keys.release] });
});

interface Run extends Partial<Omit<VerifyReleaseInput, 'release'>> {
    readonly release: TestRelease | { readonly release: unknown; readonly attestation?: FakeAttestation };
    readonly now?: Date;
    readonly attestations?: readonly FakeAttestation[];
    readonly provenance?: ProvenanceVerifier;
}

async function run(options: Run): Promise<ReleaseVerification> {
    const attestations = options.attestations ?? (options.release.attestation ? [options.release.attestation] : []);
    return verifyRelease(
        {
            release: options.release.release,
            revocations: options.revocations === undefined ? revocations : options.revocations,
            lastAcceptedRevocationIssuedAt: options.lastAcceptedRevocationIssuedAt ?? null,
            policy: options.policy ?? policy,
            mode: options.mode ?? 'auto',
            installedVersion: options.installedVersion ?? null,
            firstSeenAt: options.firstSeenAt ?? FIRST_SEEN,
            ...(options.signal ? { signal: options.signal } : {}),
        },
        {
            provenance: options.provenance ?? createFakeProvenanceVerifier(attestations),
            clock: createFixedClock(options.now ?? NOW),
        },
    );
}

function regular(overrides: Partial<TestReleaseOptions> = {}): Promise<TestRelease> {
    return testRelease({ signers: [keys.release], ...overrides });
}

function security(overrides: Partial<TestReleaseOptions> = {}): Promise<TestRelease> {
    return testRelease({
        signers: [keys.release, keys.maintainers[0], keys.maintainers[2]],
        entry: entryJson({ kind: 'security' }),
        ...overrides,
    });
}

function withSignatures(release: TestRelease, signatures: DsseEnvelope['signatures']): TestRelease {
    return { ...release, release: { ...release.release, envelope: { ...release.release.envelope, signatures } } };
}

function flipLastSignatureByte(signature: DsseEnvelope['signatures'][number]): DsseEnvelope['signatures'][number] {
    const bytes = Uint8Array.from(atob(signature.sig), (char) => char.charCodeAt(0));
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    return { keyid: signature.keyid, sig: encodeBase64Std(bytes) };
}

describe('verifyRelease outcomes', () => {
    it('ok: a regular release with provenance and the release key', async () => {
        const result = await run({ release: await regular() });
        expect(result).toMatchObject({
            kind: 'ok',
            entry: { version: '2.0.0', kind: 'regular' },
            eligibleAt: new Date(FIRST_SEEN.getTime() + 72 * HOUR),
            revocationsIssuedAt: new Date('2026-10-02T00:00:00Z'),
        });
    });

    it('ok: a security release with provenance, the release key and 2 of 3 maintainers, after 24 h', async () => {
        const result = await run({ release: await security(), now: new Date(FIRST_SEEN.getTime() + 24 * HOUR) });
        expect(result).toMatchObject({ kind: 'ok', eligibleAt: new Date(FIRST_SEEN.getTime() + 24 * HOUR) });
    });

    it('invalid-entry: not a SignedRelease', async () => {
        for (const release of [null, 'x', 42, {}, { v: 1, envelope: {}, provenance: 'b' }]) {
            expect(await run({ release: { release } })).toEqual({ kind: 'invalid-entry' });
        }
    });

    it('invalid-entry: an envelope with another payload type, even when signed by the release key', async () => {
        const release = await regular({ payloadType: REVOCATION_PAYLOAD_TYPE });
        expect(await run({ release })).toEqual({ kind: 'invalid-entry' });
    });

    it.each([
        ['an unknown field', JSON.stringify({ ...entryJson(), extra: true })],
        ['a security release without advisory', JSON.stringify(entryJson({ kind: 'security', advisory: null }))],
        ['v: 2', JSON.stringify(entryJson({ v: 2 }))],
        ['not JSON', '{"v":1,'],
    ])('invalid-entry: a payload signed by the release key with %s', async (_, payloadText) => {
        const release = await regular({ payloadText });
        expect(await run({ release })).toEqual({ kind: 'invalid-entry' });
    });

    it('signature-threshold-not-met: no signature from a trusted key', async () => {
        const release = await regular({ signers: [keys.outsider] });
        expect(await run({ release })).toEqual({ kind: 'signature-threshold-not-met', missing: 'trusted-key' });
    });

    it('not-in-log: provenance without a transparency log entry', async () => {
        const release = await regular({ logIndex: null });
        expect(await run({ release })).toEqual({ kind: 'not-in-log' });
    });

    it('revocations-unverifiable: no revocation list', async () => {
        expect(await run({ release: await regular(), revocations: null })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'missing',
        });
    });

    it('revoked: the version is on the list', async () => {
        const list = await testRevocations({
            signers: [keys.release],
            revoked: [{ version: '2.0.0', reason: 'rebuild mismatch' }],
        });
        expect(await run({ release: await regular(), revocations: list })).toMatchObject({
            kind: 'revoked',
            reason: 'rebuild mismatch',
            revocationsIssuedAt: new Date('2026-10-02T00:00:00Z'),
        });
    });

    it('not-newer: the installed version is the same', async () => {
        const result = await run({ release: await regular(), installedVersion: EngineVersion.parse('2.0.0') });
        expect(result).toMatchObject({ kind: 'not-newer', entry: { version: '2.0.0' } });
    });

    it('delay-not-elapsed: inside the 72 h of a regular release', async () => {
        const result = await run({ release: await regular(), now: new Date(FIRST_SEEN.getTime() + 71 * HOUR) });
        expect(result).toMatchObject({
            kind: 'delay-not-elapsed',
            eligibleAt: new Date(FIRST_SEEN.getTime() + 72 * HOUR),
        });
    });
});

describe('signature threshold', () => {
    it('parses only after a trusted signature: an unsigned malformed payload is not invalid-entry', async () => {
        const release = await regular({ signers: [keys.outsider], payloadText: 'not json' });
        expect(await run({ release })).toEqual({ kind: 'signature-threshold-not-met', missing: 'trusted-key' });
    });

    it('a release-key signature with invalid provenance fails', async () => {
        const release = await regular();
        const tampered = { ...release.attestation, payload: utf8Encode('{"other":"payload"}') };
        expect(await run({ release, attestations: [tampered] })).toEqual({
            kind: 'signature-threshold-not-met',
            missing: 'provenance',
        });
    });

    it('a release-key signature with missing provenance fails', async () => {
        expect(await run({ release: await regular(), attestations: [] })).toEqual({
            kind: 'signature-threshold-not-met',
            missing: 'provenance',
        });
    });

    it('a release-key signature with provenance from another workflow fails', async () => {
        const release = await regular();
        const certificate = {
            ...release.attestation.certificate,
            subjectAlternativeName: 'https://github.com/webgptorg/app/.github/workflows/other.yml@refs/tags/ui-v2.0.0',
        };
        expect(await run({ release, attestations: [{ ...release.attestation, certificate }] })).toEqual({
            kind: 'signature-threshold-not-met',
            missing: 'provenance',
        });
    });

    it('valid provenance without a release-key signature fails', async () => {
        const release = await regular({ signers: [keys.maintainers[0]] });
        expect(await run({ release })).toEqual({ kind: 'signature-threshold-not-met', missing: 'release-key' });
    });

    it('a regular release signed only by all three maintainers fails', async () => {
        const release = await regular({ signers: [...keys.maintainers] });
        expect(await run({ release })).toEqual({ kind: 'signature-threshold-not-met', missing: 'release-key' });
    });

    it('a security release with 1 valid and 1 invalid maintainer signature fails', async () => {
        const release = await security();
        const [releaseSig, maintainer, other] = release.release.envelope.signatures;
        if (!releaseSig || !maintainer || !other) throw new Error('expected three signatures');
        const result = await run({
            release: withSignatures(release, [releaseSig, maintainer, flipLastSignatureByte(other)]),
        });
        expect(result).toEqual({ kind: 'signature-threshold-not-met', missing: 'maintainers' });
    });

    it('a security release signed twice by the same maintainer fails', async () => {
        const release = await security({ signers: [keys.release, keys.maintainers[1], keys.maintainers[1]] });
        expect(await run({ release })).toEqual({ kind: 'signature-threshold-not-met', missing: 'maintainers' });
    });

    it('a security release with only the release key fails', async () => {
        const release = await security({ signers: [keys.release] });
        expect(await run({ release })).toEqual({ kind: 'signature-threshold-not-met', missing: 'maintainers' });
    });

    it('a security release with provenance and 2 maintainers but no release key fails', async () => {
        const release = await security({ signers: [keys.maintainers[0], keys.maintainers[1]] });
        expect(await run({ release })).toEqual({ kind: 'signature-threshold-not-met', missing: 'release-key' });
    });

    it('a security release with all three maintainers and the release key passes', async () => {
        const release = await security({ signers: [keys.maintainers[2], keys.release, ...keys.maintainers] });
        expect(await run({ release, now: new Date(FIRST_SEEN.getTime() + 24 * HOUR) })).toMatchObject({ kind: 'ok' });
    });

    it('a signature over the raw payload instead of the PAE fails', async () => {
        const release = {
            release: {
                v: 1,
                envelope: JSON.parse(vectors.signatureOverRawPayload.envelope) as unknown,
                provenance: 'b',
            },
        };
        expect(await run({ release })).toEqual({ kind: 'signature-threshold-not-met', missing: 'trusted-key' });
    });

    it('an outsider signature filed under the release key ID fails', async () => {
        const release = await regular({ signers: [keys.outsider] });
        const releaseKeyId = vectors.keys.find(({ role }) => role === 'release')?.keyid ?? '';
        const forged = release.release.envelope.signatures.map(({ sig }) => ({ keyid: releaseKeyId, sig }));
        expect(await run({ release: withSignatures(release, forged) })).toEqual({
            kind: 'signature-threshold-not-met',
            missing: 'trusted-key',
        });
    });

    it('changing one payload byte after signing fails', async () => {
        const release = await regular();
        const payload = JSON.stringify(entryJson({ version: '2.0.1' }));
        const envelope = { ...release.release.envelope, payload: encodeBase64Std(utf8Encode(payload)) };
        expect(await run({ release: { ...release, release: { ...release.release, envelope } } })).toEqual({
            kind: 'signature-threshold-not-met',
            missing: 'trusted-key',
        });
    });

    it('accepts the checked-in regular vector envelope', async () => {
        const envelope = JSON.parse(vectors.regular.envelope) as DsseEnvelope;
        const payload = utf8Encode(vectors.regular.payloadText);
        const release = await regular({ entry: JSON.parse(vectors.regular.payloadText) as Record<string, unknown> });
        const attestation = { ...release.attestation, payload };
        const result = await run({
            release: { release: { v: 1, envelope, provenance: attestation.bundle } },
            attestations: [attestation],
        });
        expect(result).toMatchObject({ kind: 'ok', entry: { version: '1.8.2', gitTag: 'ui-v1.8.2' } });
    });
});

describe('transparency log and trusted time', () => {
    it('valid provenance without a trusted time is not-in-log', async () => {
        expect(await run({ release: await regular({ timestamps: [] }) })).toEqual({ kind: 'not-in-log' });
    });

    it('a backdated publishedAt does not shorten the delay: the trusted time wins', async () => {
        const release = await regular({
            entry: entryJson({ publishedAt: '2020-01-01T00:00:00Z' }),
            timestamps: [TRUSTED_TIME],
        });
        const result = await run({ release, firstSeenAt: new Date('2019-01-01T00:00:00Z') });
        expect(result).toMatchObject({ kind: 'ok', eligibleAt: new Date(TRUSTED_TIME.getTime() + 72 * HOUR) });
    });

    it('a backdated publishedAt does not shorten the delay: the first-seen time wins', async () => {
        const release = await regular({ entry: entryJson({ publishedAt: '2020-01-01T00:00:00Z' }) });
        const firstSeenAt = new Date('2026-10-05T00:00:00Z');
        const result = await run({ release, firstSeenAt, now: new Date(firstSeenAt.getTime() + 72 * HOUR - 1) });
        expect(result).toMatchObject({
            kind: 'delay-not-elapsed',
            eligibleAt: new Date(firstSeenAt.getTime() + 72 * HOUR),
        });
    });

    it('a later firstSeenAt moves eligibleAt', async () => {
        const release = await regular();
        const early = await run({ release, firstSeenAt: FIRST_SEEN });
        const late = await run({ release, firstSeenAt: new Date(FIRST_SEEN.getTime() + HOUR) });
        expect(early).toMatchObject({ eligibleAt: new Date(FIRST_SEEN.getTime() + 72 * HOUR) });
        expect(late).toMatchObject({ eligibleAt: new Date(FIRST_SEEN.getTime() + 73 * HOUR) });
    });

    it('a publishedAt in the future lengthens the delay', async () => {
        const release = await regular({ entry: entryJson({ publishedAt: '2026-10-08T00:00:00Z' }) });
        expect(await run({ release })).toMatchObject({
            kind: 'delay-not-elapsed',
            eligibleAt: new Date(Date.parse('2026-10-08T00:00:00Z') + 72 * HOUR),
        });
    });

    it('uses the latest of several verified timestamps', async () => {
        const late = new Date('2026-10-03T00:00:00Z');
        const release = await regular({ timestamps: [late, TRUSTED_TIME] });
        expect(await run({ release })).toMatchObject({ eligibleAt: new Date(late.getTime() + 72 * HOUR) });
    });

    it('passes exactly at eligibleAt and fails 1 ms before', async () => {
        const release = await regular();
        const eligibleAt = new Date(FIRST_SEEN.getTime() + 72 * HOUR);
        expect(await run({ release, now: eligibleAt })).toMatchObject({ kind: 'ok', eligibleAt });
        expect(await run({ release, now: new Date(eligibleAt.getTime() - 1) })).toMatchObject({
            kind: 'delay-not-elapsed',
            eligibleAt,
        });
    });

    it('a security release waits 24 h, not less', async () => {
        const release = await security();
        const eligibleAt = new Date(FIRST_SEEN.getTime() + 24 * HOUR);
        expect(await run({ release, now: new Date(eligibleAt.getTime() - 1) })).toMatchObject({
            kind: 'delay-not-elapsed',
            eligibleAt,
        });
    });
});

describe('staging policy delays', () => {
    const MINUTE = 60_000;
    const staging = () =>
        testPolicy(keys, { profile: 'staging', delays: { regularMs: 5 * MINUTE, securityMs: 2 * MINUTE } });

    // First seen shortly before NOW, so the test revocation list is still fresh at the boundary.
    const firstSeenAt = new Date(NOW.getTime() - 10 * MINUTE);

    it('a regular release waits the policy delay from the latest of publishedAt, trusted time and first-seen', async () => {
        const release = await regular();
        const eligibleAt = new Date(firstSeenAt.getTime() + 5 * MINUTE);
        const at = (now: Date) => run({ release, policy: staging(), firstSeenAt, now });
        expect(await at(eligibleAt)).toMatchObject({ kind: 'ok', eligibleAt });
        expect(await at(new Date(eligibleAt.getTime() - 1))).toMatchObject({ kind: 'delay-not-elapsed', eligibleAt });
    });

    it('a security release waits the policy security delay', async () => {
        const release = await security();
        const eligibleAt = new Date(firstSeenAt.getTime() + 2 * MINUTE);
        const at = (now: Date) => run({ release, policy: staging(), firstSeenAt, now });
        expect(await at(eligibleAt)).toMatchObject({ kind: 'ok', eligibleAt });
        expect(await at(new Date(eligibleAt.getTime() - 1))).toMatchObject({ kind: 'delay-not-elapsed', eligibleAt });
    });

    it('a backdated publishedAt still does not shorten the delay', async () => {
        const release = await regular({ entry: entryJson({ publishedAt: '2020-01-01T00:00:00Z' }) });
        const lateFirstSeen = new Date(NOW.getTime() - 2 * MINUTE);
        expect(await run({ release, policy: staging(), firstSeenAt: lateFirstSeen })).toMatchObject({
            kind: 'delay-not-elapsed',
            eligibleAt: new Date(lateFirstSeen.getTime() + 5 * MINUTE),
        });
    });

    it('throws on a staging policy with delays the schema refuses', async () => {
        const tooShort = { ...staging(), delays: { regularMs: MINUTE - 1, securityMs: MINUTE - 1 } };
        await expect(run({ release: await regular(), policy: tooShort })).rejects.toThrow();
        const unprofiled = { ...testPolicy(keys), delays: { regularMs: 5 * MINUTE, securityMs: 2 * MINUTE } };
        await expect(run({ release: await regular(), policy: unprofiled })).rejects.toThrow();
    });
});

describe('mode', () => {
    it('manual approval skips the delay', async () => {
        const now = new Date('2026-10-02T01:00:00Z');
        const eligibleAt = new Date(FIRST_SEEN.getTime() + 72 * HOUR);
        expect(await run({ release: await regular(), now })).toMatchObject({ kind: 'delay-not-elapsed', eligibleAt });
        expect(await run({ release: await regular(), mode: 'manual', now })).toMatchObject({ kind: 'ok', eligibleAt });
    });

    it('manual approval skips no signature, log or revocation check', async () => {
        const now = FIRST_SEEN;
        expect(await run({ release: await regular({ signers: [keys.maintainers[0]] }), mode: 'manual', now })).toEqual({
            kind: 'signature-threshold-not-met',
            missing: 'release-key',
        });
        expect(await run({ release: await regular({ logIndex: null }), mode: 'manual', now })).toEqual({
            kind: 'not-in-log',
        });
        expect(await run({ release: await regular(), revocations: null, mode: 'manual', now })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'missing',
        });
    });
});

describe('revocation list', () => {
    it('an expired list is revocations-unverifiable: expired', async () => {
        const list = await testRevocations({ signers: [keys.release], expiresAt: '2026-10-09T00:00:00Z' });
        expect(await run({ release: await regular(), revocations: list })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'expired',
        });
    });

    it('a list is expired exactly at expiresAt', async () => {
        const list = await testRevocations({ signers: [keys.release], expiresAt: NOW.toISOString() });
        expect(await run({ release: await regular(), revocations: list })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'expired',
        });
    });

    it('a list older than the last accepted one is rolled-back', async () => {
        const result = await run({
            release: await regular(),
            lastAcceptedRevocationIssuedAt: new Date('2026-10-02T00:00:00.001Z'),
        });
        expect(result).toEqual({ kind: 'revocations-unverifiable', reason: 'rolled-back' });
    });

    it('a list with the same issuedAt as the last accepted one passes', async () => {
        const result = await run({
            release: await regular(),
            lastAcceptedRevocationIssuedAt: new Date('2026-10-02T00:00:00Z'),
        });
        expect(result).toMatchObject({ kind: 'ok', revocationsIssuedAt: new Date('2026-10-02T00:00:00Z') });
    });

    it('a fresh list without the version passes', async () => {
        const list = await testRevocations({
            signers: [keys.release],
            issuedAt: '2026-10-09T00:00:00Z',
            revoked: [{ version: '1.9.9', reason: 'bad' }],
        });
        const result = await run({
            release: await regular(),
            revocations: list,
            lastAcceptedRevocationIssuedAt: new Date('2026-10-02T00:00:00Z'),
        });
        expect(result).toMatchObject({ kind: 'ok', revocationsIssuedAt: new Date('2026-10-09T00:00:00Z') });
    });

    it('a list with a bad signature is invalid', async () => {
        const [signature] = revocations.signatures;
        if (!signature) throw new Error('expected a signature');
        const list = { ...revocations, signatures: [flipLastSignatureByte(signature)] };
        expect(await run({ release: await regular(), revocations: list })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'invalid',
        });
    });

    it('a list signed by an untrusted key is invalid', async () => {
        const list = await testRevocations({ signers: [keys.outsider] });
        expect(await run({ release: await regular(), revocations: list })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'invalid',
        });
    });

    it.each([
        ['not an envelope', { payload: 'x' }],
        ['a string', 'revocations'],
    ])('a list that is %s is invalid', async (_, list) => {
        expect(await run({ release: await regular(), revocations: list })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'invalid',
        });
    });

    it('a release envelope offered as the revocation list is invalid', async () => {
        const release = await regular();
        expect(await run({ release, revocations: release.release.envelope })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'invalid',
        });
    });

    it('a signed list whose payload breaks the schema is invalid', async () => {
        const list = await signDsse(
            keys.release,
            REVOCATION_PAYLOAD_TYPE,
            utf8Encode('{"v":1,"issuedAt":"2026-10-02T00:00:00Z","expiresAt":"2026-10-01T00:00:00Z","revoked":[]}'),
        );
        expect(await run({ release: await regular(), revocations: list })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'invalid',
        });
    });

    it('a maintainer may sign the list under the default rule', async () => {
        const list = await testRevocations({ signers: [keys.maintainers[2]] });
        expect(await run({ release: await regular(), revocations: list })).toMatchObject({ kind: 'ok' });
    });

    it('follows a stricter revocation rule', async () => {
        const strict = testPolicy(keys, { revocationRule: { signers: 'maintainer', threshold: 2 } });
        const one = await testRevocations({ signers: [keys.maintainers[0], keys.release] });
        const two = await testRevocations({ signers: [keys.maintainers[0], keys.maintainers[1]] });
        expect(await run({ release: await regular(), revocations: one, policy: strict })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'invalid',
        });
        expect(await run({ release: await regular(), revocations: two, policy: strict })).toMatchObject({ kind: 'ok' });
    });

    it('revokes by SemVer precedence, ignoring build metadata', async () => {
        const list = await testRevocations({
            signers: [keys.release],
            revoked: [{ version: '2.0.0+linux', reason: 'pulled' }],
        });
        expect(await run({ release: await regular(), revocations: list })).toMatchObject({ kind: 'revoked' });
    });

    it('does not revoke a pre-release of the listed version', async () => {
        const list = await testRevocations({
            signers: [keys.release],
            revoked: [{ version: '2.0.0-rc.1', reason: 'pulled' }],
        });
        expect(await run({ release: await regular(), revocations: list })).toMatchObject({ kind: 'ok' });
    });
});

describe('downgrade refusal', () => {
    it.each([
        ['an older version', '1.9.9', 'ok'],
        ['a pre-release of the same version', '2.0.0-rc.1', 'ok'],
        ['a newer version', '2.0.1', 'not-newer'],
        ['the same version with other build metadata', '2.0.0+other', 'not-newer'],
    ])('installed %s', async (_, installed, kind) => {
        const result = await run({ release: await regular(), installedVersion: EngineVersion.parse(installed) });
        expect(result.kind).toBe(kind);
    });
});

describe('order of checks', () => {
    it('reports not-in-log before a missing revocation list', async () => {
        expect(await run({ release: await regular({ logIndex: null }), revocations: null })).toEqual({
            kind: 'not-in-log',
        });
    });

    it('reports an unverifiable list before a revoked or older version', async () => {
        const result = await run({
            release: await regular(),
            revocations: null,
            installedVersion: EngineVersion.parse('3.0.0'),
        });
        expect(result).toEqual({ kind: 'revocations-unverifiable', reason: 'missing' });
    });

    it('reports revoked before not-newer', async () => {
        const list = await testRevocations({ signers: [keys.release], revoked: [{ version: '2.0.0', reason: 'x' }] });
        const result = await run({
            release: await regular(),
            revocations: list,
            installedVersion: EngineVersion.parse('3.0.0'),
        });
        expect(result.kind).toBe('revoked');
    });

    it('does not ask for provenance when the keys already fall short', async () => {
        let calls = 0;
        const provenance: ProvenanceVerifier = {
            verifyProvenance() {
                calls++;
                return Promise.resolve({ kind: 'invalid', reason: 'unused' });
            },
        };
        await run({ release: await regular({ signers: [keys.maintainers[0]] }), provenance });
        expect(calls).toBe(0);
    });

    it('asks for provenance with the exact payload, payload type and expected identity', async () => {
        const release = await regular();
        const seen: unknown[] = [];
        const provenance: ProvenanceVerifier = {
            verifyProvenance(bundle, envelope, expected) {
                seen.push(bundle, envelope.payloadType, [...envelope.payload], expected.subjectAlternativeName);
                return Promise.resolve({ kind: 'verified', logIndex: 1, trustedTime: TRUSTED_TIME });
            },
        };
        expect(await run({ release, provenance })).toMatchObject({ kind: 'ok' });
        expect(seen).toEqual([
            release.release.provenance,
            RELEASE_PAYLOAD_TYPE,
            [...release.payload],
            'https://github.com/webgptorg/app/.github/workflows/ui-release.yml@refs/tags/ui-v2.0.0',
        ]);
    });
});

describe('inputs that are bugs, not data', () => {
    it.each([
        ['clock', { now: new Date(Number.NaN) }],
        ['firstSeenAt', { firstSeenAt: new Date(Number.NaN) }],
        ['lastAcceptedRevocationIssuedAt', { lastAcceptedRevocationIssuedAt: new Date(Number.NaN) }],
    ])('throws on an invalid %s date', async (_, override) => {
        await expect(run({ release: await regular(), ...override })).rejects.toThrow(RangeError);
    });

    it('throws on an invalid trusted time from an adapter', async () => {
        const provenance: ProvenanceVerifier = {
            verifyProvenance: () =>
                Promise.resolve({ kind: 'verified', logIndex: 1, trustedTime: new Date(Number.NaN) }),
        };
        await expect(run({ release: await regular(), provenance })).rejects.toThrow(RangeError);
    });

    it('throws on a hand-built policy whose release key is also a maintainer key', async () => {
        const overlapping = { ...policy, maintainerKeys: [policy.releaseKeys[0], ...policy.maintainerKeys.slice(1)] };
        await expect(run({ release: await regular(), policy: overlapping as TrustPolicy })).rejects.toThrow();
    });

    it('throws instead of skipping the delay when eligibleAt overflows the Date range', async () => {
        await expect(run({ release: await regular(), firstSeenAt: new Date(8.64e15) })).rejects.toThrow(RangeError);
    });

    it('passes the abort signal to the provenance verifier', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(run({ release: await regular(), signal: controller.signal })).rejects.toThrow();
    });

    it('a policy with another release key refuses the release', async () => {
        const other = testPolicy(keys, {
            releaseKeys: [{ publicKey: ed25519PublicKeyFromBytes(keys.outsider.publicKey()) }],
        });
        expect(await run({ release: await regular(), policy: other })).toEqual({
            kind: 'signature-threshold-not-met',
            missing: 'trusted-key',
        });
    });
});

describe('revocation list time bounds (decided 2026-10-20)', () => {
    it('allows 5 minutes of clock skew', () => {
        expect(REVOCATION_MAX_FUTURE_SKEW_MS).toBe(5 * 60 * 1000);
    });

    it('refuses a far-future list signed by one maintainer, and still accepts a later genuine list', async () => {
        const release = await regular();
        const lastAcceptedRevocationIssuedAt = new Date('2026-10-02T00:00:00Z');
        const future = await testRevocations({
            signers: [keys.maintainers[0]],
            issuedAt: '9999-01-01T00:00:00Z',
            expiresAt: '9999-01-02T00:00:00Z',
        });
        const refused = await run({ release, revocations: future, lastAcceptedRevocationIssuedAt });
        expect(refused).toEqual({ kind: 'revocations-unverifiable', reason: 'invalid' });
        expect(refused).not.toHaveProperty('revocationsIssuedAt');

        const genuine = await testRevocations({ signers: [keys.release], issuedAt: '2026-10-09T00:00:00Z' });
        expect(await run({ release, revocations: genuine, lastAcceptedRevocationIssuedAt })).toMatchObject({
            kind: 'ok',
            revocationsIssuedAt: new Date('2026-10-09T00:00:00Z'),
        });
    });

    it('accepts issuedAt exactly 5 minutes ahead and refuses 1 ms more', async () => {
        const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
        const edge = await testRevocations({
            signers: [keys.release],
            issuedAt: at(REVOCATION_MAX_FUTURE_SKEW_MS),
            expiresAt: at(24 * HOUR),
        });
        const beyond = await testRevocations({
            signers: [keys.release],
            issuedAt: at(REVOCATION_MAX_FUTURE_SKEW_MS + 1),
            expiresAt: at(24 * HOUR),
        });
        expect(await run({ release: await regular(), revocations: edge })).toMatchObject({ kind: 'ok' });
        expect(await run({ release: await regular(), revocations: beyond })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'invalid',
        });
    });

    it('refuses a list valid for more than 30 days', async () => {
        const list = await testRevocations({ signers: [keys.release], expiresAt: '2026-11-01T00:00:00.001Z' });
        expect(await run({ release: await regular(), revocations: list })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'invalid',
        });
    });
});

describe('duplicate JSON keys (decided 2026-10-20)', () => {
    const entry = JSON.stringify(entryJson());

    it.each([
        ['a top-level key', entry.replace('"v":1,', '"v":1,"version":"9.9.9",')],
        ['a key inside an artifact', entry.replace('"kind":"ui"}', '"kind":"ui","kind":"engine"}')],
        ['a key spelled with an escape', entry.replace('"v":1,', '"v":1,"\\u0076ersion":"9.9.9",')],
    ])('a signed release payload with %s is invalid-entry', async (_, payloadText) => {
        expect(payloadText).not.toBe(entry);
        expect(await run({ release: await regular({ payloadText }) })).toEqual({ kind: 'invalid-entry' });
    });

    it('a signed revocation payload with a duplicate key is invalid', async () => {
        const list = await signDsse(
            keys.release,
            REVOCATION_PAYLOAD_TYPE,
            utf8Encode(
                '{"v":1,"issuedAt":"2026-10-02T00:00:00Z","expiresAt":"2026-10-09T00:00:00Z",' +
                    '"revoked":[{"version":"2.0.0","reason":"x"}],"revoked":[]}',
            ),
        );
        expect(await run({ release: await regular(), revocations: list })).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'invalid',
        });
    });

    it.each(vectors.duplicateKeys.vectors.map((vector) => [vector.id, vector] as const))(
        'the checked-in duplicate-key vector %s is invalid-entry',
        async (_, vector) => {
            const release = await regular({ payloadText: vector.payloadText });
            const envelope = JSON.parse(vector.envelope) as unknown;
            const result = await run({
                release: { release: { v: 1, envelope, provenance: release.attestation.bundle } },
                attestations: [release.attestation],
            });
            expect(result).toEqual({ kind: 'invalid-entry' });
        },
    );
});
