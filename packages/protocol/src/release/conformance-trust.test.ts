import { beforeAll, describe, expect, it } from 'vitest';

import type { ReleaseTestKeys } from '../testing/release';
import { releaseTestKeys, testPolicy } from '../testing/release';
import { CONFORMANCE_TRUST_FILE_ENV, ConformanceTrustFile } from './conformance-trust';

let keys: ReleaseTestKeys;
let file: Record<string, unknown>;

beforeAll(async () => {
    keys = await releaseTestKeys();
    file = {
        v: 1,
        trustPolicy: testPolicy(keys),
        trustedRoot: { mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1' },
    };
});

const parses = (fields: Record<string, unknown>) => ConformanceTrustFile.safeParse({ ...file, ...fields }).success;

describe('ConformanceTrustFile', () => {
    it('names the variable engines read it from', () => {
        expect(CONFORMANCE_TRUST_FILE_ENV).toBe('PTBK_CONFORMANCE_TRUST_FILE');
    });

    it('accepts a trust policy with a trusted root', () => {
        expect(ConformanceTrustFile.parse(file)).toEqual(file);
    });

    it('rejects unknown and missing fields', () => {
        expect(parses({ releaseKey: 'x' })).toBe(false);
        expect(ConformanceTrustFile.safeParse({ v: 1, trustPolicy: file['trustPolicy'] }).success).toBe(false);
    });

    it('rejects any other version', () => {
        expect(parses({ v: 2 })).toBe(false);
        expect(parses({ v: '1' })).toBe(false);
    });

    it('rejects an invalid trust policy', () => {
        const policy = testPolicy(keys);
        expect(parses({ trustPolicy: { ...policy, securityThreshold: 1 } })).toBe(false);
        expect(parses({ trustPolicy: { ...policy, delays: { regularMs: 0, securityMs: 0 } } })).toBe(false);
        expect(parses({ trustPolicy: { ...policy, extra: true } })).toBe(false);
    });

    it('rejects a staging trust policy: the suite expects the production delays', () => {
        const staging = {
            ...testPolicy(keys),
            profile: 'staging',
            delays: { regularMs: 300_000, securityMs: 300_000 },
        };
        expect(parses({ trustPolicy: staging })).toBe(false);
        expect(parses({ trustPolicy: { ...testPolicy(keys), profile: 'staging' } })).toBe(false);
    });

    it('rejects a trusted root that is not a JSON object', () => {
        expect(parses({ trustedRoot: [] })).toBe(false);
        expect(parses({ trustedRoot: 'trusted_root.json' })).toBe(false);
        expect(parses({ trustedRoot: null })).toBe(false);
    });
});
