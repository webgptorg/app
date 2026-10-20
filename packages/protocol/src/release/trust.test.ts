import { beforeAll, describe, expect, it } from 'vitest';
import { ed25519PublicKeyFromBytes } from '../ids';
import type { ReleaseTestKeys } from '../testing/release';
import { WORKFLOW_IDENTITY, releaseTestKeys, testPolicy } from '../testing/release';
import { RELEASE_DELAYS, TrustPolicy, revocationSigners } from './trust';

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
