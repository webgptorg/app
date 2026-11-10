import { beforeAll, describe, expect, it } from 'vitest';
import { ed25519PublicKeyFromBytes } from '../ids';
import type { ReleaseTestKeys } from '../testing/release';
import { WORKFLOW_IDENTITY, releaseTestKeys, testPolicy } from '../testing/release';
import {
    ProductionTrustPolicy,
    RELEASE_DELAYS,
    STAGING_MIN_DELAY_MS,
    StagingTrustPolicy,
    TrustPolicy,
    isStagingPolicy,
    revocationSigners,
} from './trust';

let keys: ReleaseTestKeys;
let raw: Record<string, unknown>;

const ref = (signer: { publicKey(): Uint8Array<ArrayBuffer> }) => ({
    publicKey: ed25519PublicKeyFromBytes(signer.publicKey()),
});

beforeAll(async () => {
    keys = await releaseTestKeys();
    raw = {
        releaseKeys: [ref(keys.release)],
        maintainerKeys: keys.maintainers.map(ref),
        securityThreshold: 2,
        workflowIdentity: WORKFLOW_IDENTITY,
        revocationRule: { signers: 'release-or-maintainer', threshold: 1 },
        delays: { regularMs: RELEASE_DELAYS.regularMs, securityMs: RELEASE_DELAYS.securityMs },
    };
});

const parses = (fields: Record<string, unknown>) => TrustPolicy.safeParse({ ...raw, ...fields }).success;

describe('TrustPolicy', () => {
    it('accepts the default test policy', () => {
        expect(parses({})).toBe(true);
        expect(testPolicy(keys).delays).toEqual({ regularMs: 72 * 3_600_000, securityMs: 24 * 3_600_000 });
    });

    it('accepts several distinct release keys', () => {
        expect(parses({ releaseKeys: [ref(keys.release), ref(keys.outsider)] })).toBe(true);
    });

    it('rejects a key that is both a release and a maintainer key', () => {
        expect(parses({ releaseKeys: [ref(keys.maintainers[0])] })).toBe(false);
        expect(parses({ releaseKeys: [ref(keys.release), ref(keys.maintainers[2])] })).toBe(false);
    });

    it('rejects two identical maintainer keys', () => {
        const [first, second] = keys.maintainers;
        expect(parses({ maintainerKeys: [ref(first), ref(second), ref(first)] })).toBe(false);
    });

    it('rejects two identical release keys', () => {
        expect(parses({ releaseKeys: [ref(keys.release), ref(keys.release)] })).toBe(false);
    });

    it.each([
        ['two maintainer keys', () => ({ maintainerKeys: keys.maintainers.slice(0, 2).map(ref) })],
        ['four maintainer keys', () => ({ maintainerKeys: [...keys.maintainers.map(ref), ref(keys.outsider)] })],
        ['no release keys', () => ({ releaseKeys: [] })],
        ['nine release keys', () => ({ releaseKeys: Array.from({ length: 9 }, () => ref(keys.outsider)) })],
        ['security threshold 1', () => ({ securityThreshold: 1 })],
        ['security threshold 3', () => ({ securityThreshold: 3 })],
        ['a zero regular delay', () => ({ delays: { regularMs: 0, securityMs: RELEASE_DELAYS.securityMs } })],
        [
            'a shorter security delay',
            () => ({ delays: { regularMs: RELEASE_DELAYS.regularMs, securityMs: 3_600_000 } }),
        ],
        ['an unknown delay field', () => ({ delays: { ...RELEASE_DELAYS, manualMs: 0 } })],
        ['another issuer', () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, issuer: 'https://gitlab.com' } })],
        ['a repository without owner', () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, repository: 'app' } })],
        [
            'a repository with a regex',
            () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, repository: 'webgptorg/.*' } }),
        ],
        [
            'repositoryId with a leading zero',
            () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, repositoryId: '0123' } }),
        ],
        ['a non-numeric repositoryId', () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, repositoryId: 'abc' } })],
        [
            'a workflow outside .github/workflows',
            () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, workflowPath: 'scripts/release.yml' } }),
        ],
        [
            'a workflow path with ..',
            () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, workflowPath: '.github/workflows/../release.yml' } }),
        ],
        [
            'a workflow path with a tag',
            () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, workflowPath: '.github/workflows/ui-release.yml@x' } }),
        ],
        ['an unknown workflow identity field', () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, ref: 'main' } })],
        [
            'a revocation threshold above the allowed keys',
            () => ({ revocationRule: { signers: 'release', threshold: 2 } }),
        ],
        ['a maintainer revocation threshold of 4', () => ({ revocationRule: { signers: 'maintainer', threshold: 4 } })],
        ['a revocation threshold of 0', () => ({ revocationRule: { signers: 'release-or-maintainer', threshold: 0 } })],
        ['an unknown revocation signer set', () => ({ revocationRule: { signers: 'anyone', threshold: 1 } })],
        ['an unknown key field', () => ({ releaseKeys: [{ ...ref(keys.release), keyid: 'x' }] })],
        ['a key that is not 32 bytes', () => ({ releaseKeys: [{ publicKey: 'AAAA' }] })],
        ['an unknown field', () => ({ allowUnsigned: true })],
    ])('rejects %s', (_, fields) => {
        expect(parses(fields())).toBe(false);
    });

    it('accepts a revocation threshold up to the allowed keys', () => {
        expect(parses({ revocationRule: { signers: 'maintainer', threshold: 3 } })).toBe(true);
        expect(parses({ revocationRule: { signers: 'release-or-maintainer', threshold: 4 } })).toBe(true);
        expect(parses({ revocationRule: { signers: 'release-or-maintainer', threshold: 5 } })).toBe(false);
    });
});

describe('TrustPolicy with the staging profile', () => {
    const MINUTE_MS = 60_000;
    const staging = (delays: Record<string, unknown>, fields: Record<string, unknown> = {}) => ({
        ...raw,
        profile: 'staging',
        delays,
        ...fields,
    });
    const parsesStaging = (delays: Record<string, unknown>, fields: Record<string, unknown> = {}) =>
        TrustPolicy.safeParse(staging(delays, fields)).success;

    it('accepts delays from 1 minute up to the production values', () => {
        expect(STAGING_MIN_DELAY_MS).toBe(MINUTE_MS);
        expect(parsesStaging({ regularMs: 5 * MINUTE_MS, securityMs: 5 * MINUTE_MS })).toBe(true);
        expect(parsesStaging({ regularMs: MINUTE_MS, securityMs: MINUTE_MS })).toBe(true);
        expect(parsesStaging({ regularMs: RELEASE_DELAYS.regularMs, securityMs: RELEASE_DELAYS.securityMs })).toBe(
            true,
        );
        expect(parsesStaging({ regularMs: 10 * MINUTE_MS, securityMs: 2 * MINUTE_MS })).toBe(true);
    });

    it('tells a staging policy from a production one', () => {
        const policy = TrustPolicy.parse(staging({ regularMs: 5 * MINUTE_MS, securityMs: 5 * MINUTE_MS }));
        expect(isStagingPolicy(policy)).toBe(true);
        expect(isStagingPolicy(TrustPolicy.parse(raw))).toBe(false);
        expect(isStagingPolicy(testPolicy(keys))).toBe(false);
    });

    it('is never a production policy', () => {
        expect(ProductionTrustPolicy.safeParse(staging(RELEASE_DELAYS)).success).toBe(false);
        expect(ProductionTrustPolicy.safeParse(raw).success).toBe(true);
        expect(StagingTrustPolicy.safeParse(raw).success).toBe(false);
    });

    it.each([
        ['an hour regular delay', { regularMs: 3_600_000, securityMs: RELEASE_DELAYS.securityMs }],
        ['a 5 minute security delay', { regularMs: RELEASE_DELAYS.regularMs, securityMs: 300_000 }],
        ['5 minute delays', { regularMs: 300_000, securityMs: 300_000 }],
    ])('rejects %s without the profile', (_, delays) => {
        expect(parses({ delays })).toBe(false);
    });

    it.each([
        ['a regular delay below 1 minute', { regularMs: MINUTE_MS - 1, securityMs: MINUTE_MS - 1 }],
        ['a security delay below 1 minute', { regularMs: MINUTE_MS, securityMs: MINUTE_MS - 1 }],
        ['zero delays', { regularMs: 0, securityMs: 0 }],
        ['negative delays', { regularMs: -MINUTE_MS, securityMs: -MINUTE_MS }],
        [
            'a regular delay above production',
            { regularMs: RELEASE_DELAYS.regularMs + 1, securityMs: RELEASE_DELAYS.securityMs },
        ],
        [
            'a security delay above production',
            { regularMs: RELEASE_DELAYS.regularMs, securityMs: RELEASE_DELAYS.securityMs + 1 },
        ],
        ['a security delay longer than the regular one', { regularMs: 5 * MINUTE_MS, securityMs: 5 * MINUTE_MS + 1 }],
        ['a fractional delay', { regularMs: 300_000.5, securityMs: 300_000 }],
        ['a delay as a string', { regularMs: '300000', securityMs: 300_000 }],
        ['a missing security delay', { regularMs: 300_000 }],
        ['an unknown delay field', { regularMs: 300_000, securityMs: 300_000, manualMs: 0 }],
    ])('rejects %s', (_, delays) => {
        expect(parsesStaging(delays)).toBe(false);
    });

    it.each(['production', 'Staging', 'dev', '', null, true])('rejects the profile %j', (profile) => {
        expect(parses({ profile })).toBe(false);
        expect(parsesStaging({ regularMs: 300_000, securityMs: 300_000 }, { profile })).toBe(false);
    });

    it.each([
        ['a key that is both a release and a maintainer key', () => ({ releaseKeys: [ref(keys.maintainers[0])] })],
        [
            'two identical maintainer keys',
            () => ({ maintainerKeys: [ref(keys.maintainers[0]), ref(keys.maintainers[1]), ref(keys.maintainers[0])] }),
        ],
        ['two identical release keys', () => ({ releaseKeys: [ref(keys.release), ref(keys.release)] })],
        ['security threshold 1', () => ({ securityThreshold: 1 })],
        ['another issuer', () => ({ workflowIdentity: { ...WORKFLOW_IDENTITY, issuer: 'https://gitlab.com' } })],
        [
            'a revocation threshold above the allowed keys',
            () => ({ revocationRule: { signers: 'release', threshold: 2 } }),
        ],
        ['an unknown field', () => ({ allowUnsigned: true })],
    ])('rejects a staging policy with %s', (_, fields) => {
        expect(parsesStaging({ regularMs: 300_000, securityMs: 300_000 }, fields())).toBe(false);
    });
});

describe('revocationSigners', () => {
    it.each([
        ['release', () => [ref(keys.release)]],
        ['maintainer', () => keys.maintainers.map(ref)],
        ['release-or-maintainer', () => [ref(keys.release), ...keys.maintainers.map(ref)]],
    ] as const)('returns the %s keys', (signers, expected) => {
        const policy = testPolicy(keys, { revocationRule: { signers, threshold: 1 } });
        expect(revocationSigners(policy)).toEqual(expected());
    });
});
