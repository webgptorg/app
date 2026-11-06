import type { DsseEnvelope, SignedRelease, TrustPolicy, WorkflowIdentity } from '@ptbk/protocol';
import {
    DEFAULT_REVOCATION_RULE,
    GITHUB_ACTIONS_ISSUER,
    RELEASE_DELAYS,
    RELEASE_PAYLOAD_TYPE,
    REVOCATION_MAX_VALIDITY_MS,
    REVOCATION_PAYLOAD_TYPE,
    SECURITY_THRESHOLD,
    createFakeProvenanceVerifier,
    createFixedClock,
    dssePayload,
    encodeBase64Std,
    encodeBase64Url,
    ed25519PublicKeyFromBytes,
    expectedWorkflowClaims,
    signDsse,
    verifyRelease,
} from '@ptbk/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildReleasePayload } from './release-entry.ts';
import type { IssueRevocationListInput } from './revocation-list.ts';
import {
    MAX_VALID_DAYS,
    RevocationListError,
    issueRevocationList,
    parseRevokeArgument,
    parseValidDays,
    readRevocationList,
} from './revocation-list.ts';
import { ReleaseKeyError, releaseSignerFromSeed, signRelease } from './signed-release.ts';

const seed = (byte: number): string => encodeBase64Url(new Uint8Array(32).fill(byte));
const RELEASE_SEED = seed(1);
const MAINTAINER_SEED = seed(2);
const OUTSIDER_SEED = seed(9);
const NOW = new Date('2026-11-06T12:00:00.000Z');
const COMMIT = 'e'.repeat(40);
const TAG = 'ui-v0.2.0';
const IDENTITY: WorkflowIdentity = {
    issuer: GITHUB_ACTIONS_ISSUER,
    repository: 'webgptorg/app',
    repositoryId: '1411959168',
    workflowPath: '.github/workflows/ui-release.yml',
};

let policy: TrustPolicy;
let release: SignedRelease;
let releasePayload: Uint8Array<ArrayBuffer>;
beforeAll(async () => {
    const key = async (byte: number) => ({
        publicKey: ed25519PublicKeyFromBytes((await releaseSignerFromSeed(seed(byte))).publicKey()),
    });
    policy = {
        releaseKeys: [await key(1)],
        maintainerKeys: [await key(2), await key(3), await key(4)],
        securityThreshold: SECURITY_THRESHOLD,
        workflowIdentity: IDENTITY,
        revocationRule: DEFAULT_REVOCATION_RULE,
        delays: { regularMs: RELEASE_DELAYS.regularMs, securityMs: RELEASE_DELAYS.securityMs },
    };
    releasePayload = buildReleasePayload({
        version: '0.2.0',
        gitTag: TAG,
        commit: COMMIT,
        archiveSha256: 'f'.repeat(64),
        publishedAt: new Date('2026-11-01T12:00:00.000Z'),
    });
    release = await signRelease({ payload: releasePayload, provenance: '{"fake":1}', seed: RELEASE_SEED, policy });
});

function issue(change: Partial<IssueRevocationListInput> = {}) {
    return issueRevocationList({
        seed: RELEASE_SEED,
        policy,
        now: NOW,
        validDays: 30,
        previous: null,
        revoke: [],
        ...change,
    });
}

/** What an engine decides on a valid 0.2.0 release with this list, as C-06's `verifyRelease` (manual: no delay). */
function engineVerdict(revocations: unknown, at: Date, lastAccepted: Date | null = null) {
    const claims = expectedWorkflowClaims(IDENTITY, { gitTag: TAG, commit: COMMIT });
    const provenance = createFakeProvenanceVerifier([
        {
            bundle: release.provenance,
            payloadType: RELEASE_PAYLOAD_TYPE,
            payload: releasePayload,
            certificate: {
                issuer: claims.issuer,
                subjectAlternativeName: claims.subjectAlternativeName,
                extensions: new Map(Object.entries(claims.extensions)),
            },
            logIndex: 7,
            timestamps: [new Date('2026-11-01T12:00:00.000Z')],
        },
    ]);
    return verifyRelease(
        {
            release: JSON.parse(JSON.stringify(release)),
            revocations: JSON.parse(JSON.stringify(revocations)),
            lastAcceptedRevocationIssuedAt: lastAccepted,
            policy,
            mode: 'manual',
            installedVersion: null,
            firstSeenAt: at,
        },
        { provenance, clock: createFixedClock(at) },
    );
}

const later = (ms: number): Date => new Date(NOW.getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;

describe('issueRevocationList', () => {
    it('issues an empty list, valid for 30 days, that an engine accepts', async () => {
        const issued = await issue();
        expect(issued.envelope.payloadType).toBe(REVOCATION_PAYLOAD_TYPE);
        expect(issued.list).toEqual({
            v: 1,
            issuedAt: '2026-11-06T12:00:00.000Z',
            expiresAt: '2026-12-06T12:00:00.000Z',
            revoked: [],
        });
        expect(JSON.parse(new TextDecoder().decode(dssePayload(issued.envelope)))).toEqual(issued.list);
        expect(issued.keyId).toBe(issued.envelope.signatures[0]?.keyid);
        expect(await engineVerdict(issued.envelope, NOW)).toMatchObject({ kind: 'ok', revocationsIssuedAt: NOW });
    });

    it('revokes a named version so an engine refuses it', async () => {
        const issued = await issue({ revoke: [{ version: '0.2.0', reason: 'leaks drafts' }] });
        expect(await engineVerdict(issued.envelope, NOW)).toMatchObject({ kind: 'revoked', reason: 'leaks drafts' });
    });

    it('expires: an engine refuses the list from expiresAt on and keeps its bundle', async () => {
        const issued = await issue({ validDays: 14 });
        expect(await engineVerdict(issued.envelope, later(14 * DAY - 1))).toMatchObject({ kind: 'ok' });
        expect(await engineVerdict(issued.envelope, later(14 * DAY))).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'expired',
        });
    });

    it('a re-signed list supersedes the old one: an engine that accepted it refuses the old one as rolled back', async () => {
        const first = await issue();
        const next = await issue({ now: later(14 * DAY), previous: first.envelope });
        const at = later(14 * DAY);
        expect(await engineVerdict(next.envelope, at, NOW)).toMatchObject({ kind: 'ok', revocationsIssuedAt: at });
        expect(await engineVerdict(first.envelope, at, at)).toEqual({
            kind: 'revocations-unverifiable',
            reason: 'rolled-back',
        });
    });

    it('carries every revoked version of the previous list forward and adds new ones', async () => {
        const first = await issue({ revoke: [{ version: '0.1.0', reason: 'first' }] });
        const next = await issue({
            now: later(DAY),
            previous: first.envelope,
            revoke: [{ version: '0.2.0', reason: 'second' }],
        });
        expect(next.list.revoked).toEqual([
            { version: '0.1.0', reason: 'first' },
            { version: '0.2.0', reason: 'second' },
        ]);
        const plain = await issue({ now: later(2 * DAY), previous: next.envelope });
        expect(plain.list.revoked.map(({ version }) => version)).toEqual(['0.1.0', '0.2.0']);
    });

    it('carries an expired previous list forward, since a lapse must not un-revoke anything', async () => {
        const first = await issue({ validDays: 1, revoke: [{ version: '0.1.0', reason: 'first' }] });
        const next = await issue({ now: later(10 * DAY), previous: first.envelope });
        expect(next.list.revoked).toEqual([{ version: '0.1.0', reason: 'first' }]);
    });

    it('refuses to issue a list that predates the published one, and accepts the same instant', async () => {
        const published = await issue({ now: later(DAY) });
        await expect(issue({ previous: published.envelope })).rejects.toThrow(
            new RevocationListError(
                'the previous list was issued at 2026-11-07T12:00:00.000Z, after now; engines would refuse this one as rolled back',
            ),
        );
        await expect(issue({ now: later(DAY), previous: published.envelope })).resolves.toBeDefined();
    });

    it('refuses a previous list that does not verify under the policy', async () => {
        const outsiderPolicy: TrustPolicy = {
            ...policy,
            releaseKeys: [
                { publicKey: ed25519PublicKeyFromBytes((await releaseSignerFromSeed(OUTSIDER_SEED)).publicKey()) },
            ],
        };
        const foreign = await issue({ seed: OUTSIDER_SEED, policy: outsiderPolicy });
        const genuine = await issue();
        const tampered: DsseEnvelope = {
            ...genuine.envelope,
            payload: encodeBase64Std(
                new TextEncoder().encode(JSON.stringify({ ...genuine.list, issuedAt: '2026-11-01T00:00:00.000Z' })),
            ),
        };
        const signer = await releaseSignerFromSeed(RELEASE_SEED);
        const releaseTyped = await signDsse(signer, RELEASE_PAYLOAD_TYPE, dssePayload(genuine.envelope));
        const notAList = await signDsse(signer, REVOCATION_PAYLOAD_TYPE, new TextEncoder().encode('{"v":1}'));
        for (const previous of [foreign.envelope, tampered, releaseTyped, notAList, { not: 'an envelope' }]) {
            await expect(issue({ now: later(DAY), previous })).rejects.toThrow(
                new RevocationListError('the previous list does not verify under the trust policy'),
            );
        }
    });

    it('signs with a maintainer key when the rule allows maintainers', async () => {
        const issued = await issue({ seed: MAINTAINER_SEED });
        expect(await engineVerdict(issued.envelope, NOW)).toMatchObject({ kind: 'ok' });
    });

    it('refuses a key the revocation rule does not allow', async () => {
        const denied = new ReleaseKeyError('the trust policy does not let this key sign revocation lists');
        await expect(issue({ seed: OUTSIDER_SEED })).rejects.toThrow(denied);
        const maintainersOnly = { ...policy, revocationRule: { signers: 'maintainer' as const, threshold: 1 } };
        await expect(issue({ policy: maintainersOnly })).rejects.toThrow(denied);
        const releaseOnly = { ...policy, revocationRule: { signers: 'release' as const, threshold: 1 } };
        await expect(issue({ seed: MAINTAINER_SEED, policy: releaseOnly })).rejects.toThrow(denied);
    });

    it('refuses a rule that needs more than one signature', async () => {
        const twoOf = { ...policy, revocationRule: { signers: 'release-or-maintainer' as const, threshold: 2 } };
        await expect(issue({ policy: twoOf })).rejects.toThrow(
            new RevocationListError('the trust policy needs 2 signatures; this command signs with one key'),
        );
    });

    it('refuses a malformed seed', async () => {
        await expect(issue({ seed: 'not a seed' })).rejects.toThrow(ReleaseKeyError);
    });

    it('accepts 1 to 30 whole days only', async () => {
        expect(MAX_VALID_DAYS * DAY).toBe(REVOCATION_MAX_VALIDITY_MS);
        const one = await issue({ validDays: 1 });
        expect(one.list.expiresAt).toBe('2026-11-07T12:00:00.000Z');
        for (const validDays of [0, 31, 1.5, Number.NaN]) {
            await expect(issue({ validDays })).rejects.toThrow(
                new RevocationListError('a list is valid for 1 to 30 whole days'),
            );
        }
    });

    it('refuses an invalid version, an over-long reason and a version revoked twice', async () => {
        await expect(issue({ revoke: [{ version: 'v1', reason: 'x' }] })).rejects.toThrow(/^revoked: 0: version: /);
        await expect(issue({ revoke: [{ version: '1.0.0', reason: 'x'.repeat(501) }] })).rejects.toThrow(
            /^revoked: 0: reason: /,
        );
        const first = await issue({ revoke: [{ version: '0.1.0', reason: 'first' }] });
        await expect(
            issue({ now: later(DAY), previous: first.envelope, revoke: [{ version: '0.1.0+build', reason: 'again' }] }),
        ).rejects.toThrow('revoked versions must be unique');
    });
});

describe('readRevocationList', () => {
    it('reads a list signed under the policy, expired or not', async () => {
        const issued = await issue({ validDays: 1 });
        expect(await readRevocationList(issued.envelope, policy)).toEqual(issued.list);
    });
});

describe('parseRevokeArgument', () => {
    it('splits at the first =', () => {
        expect(parseRevokeArgument('0.2.0=breaks sign-in = badly')).toEqual({
            version: '0.2.0',
            reason: 'breaks sign-in = badly',
        });
    });

    it('refuses a missing version or reason', () => {
        for (const text of ['0.2.0', '=reason', '0.2.0=']) {
            expect(() => parseRevokeArgument(text)).toThrow(RevocationListError);
        }
    });
});

describe('parseValidDays', () => {
    it('defaults to the 30-day maximum and takes whole days', () => {
        expect(parseValidDays(undefined)).toBe(30);
        expect(parseValidDays('14')).toBe(14);
    });

    it('refuses anything but digits', () => {
        for (const text of ['', '1.5', '-1', '14d']) expect(() => parseValidDays(text)).toThrow(RevocationListError);
    });
});
