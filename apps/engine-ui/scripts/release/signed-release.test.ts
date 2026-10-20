import type { TrustPolicy } from '@ptbk/protocol';
import {
    DEFAULT_REVOCATION_RULE,
    GITHUB_ACTIONS_ISSUER,
    RELEASE_DELAYS,
    RELEASE_PAYLOAD_TYPE,
    SECURITY_THRESHOLD,
    dssePayload,
    ed25519PublicKeyFromBytes,
    ed25519PublicKeyToBytes,
    encodeBase64Url,
    verifyDsseSignatures,
} from '@ptbk/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildReleasePayload } from './release-entry.ts';
import { ReleaseKeyError, releaseSignerFromSeed, signRelease } from './signed-release.ts';

const seed = (byte: number): string => encodeBase64Url(new Uint8Array(32).fill(byte));
const payload = buildReleasePayload({
    version: '0.1.0',
    gitTag: 'ui-v0.1.0',
    commit: 'e'.repeat(40),
    archiveSha256: 'f'.repeat(64),
    publishedAt: new Date('2026-10-20T12:00:00.000Z'),
});

let policy: TrustPolicy;
beforeAll(async () => {
    const key = async (byte: number) => ({
        publicKey: ed25519PublicKeyFromBytes((await releaseSignerFromSeed(seed(byte))).publicKey()),
    });
    policy = {
        releaseKeys: [await key(1)],
        maintainerKeys: [await key(2), await key(3), await key(4)],
        securityThreshold: SECURITY_THRESHOLD,
        workflowIdentity: {
            issuer: GITHUB_ACTIONS_ISSUER,
            repository: 'webgptorg/app',
            repositoryId: '1411959168',
            workflowPath: '.github/workflows/ui-release.yml',
        },
        revocationRule: DEFAULT_REVOCATION_RULE,
        delays: { regularMs: RELEASE_DELAYS.regularMs, securityMs: RELEASE_DELAYS.securityMs },
    };
});

describe('signRelease', () => {
    it('signs the DSSE PAE of the exact payload bytes and keeps the provenance text', async () => {
        const signed = await signRelease({ payload, provenance: '{"bundle":1}', seed: seed(1), policy });
        expect(signed.envelope.payloadType).toBe(RELEASE_PAYLOAD_TYPE);
        expect(dssePayload(signed.envelope)).toEqual(payload);
        expect(signed.provenance).toBe('{"bundle":1}');
        const key = policy.releaseKeys[0];
        if (key === undefined) throw new Error('fixture');
        const valid = await verifyDsseSignatures(signed.envelope, [ed25519PublicKeyToBytes(key.publicKey)]);
        expect(valid.size).toBe(1);
    });

    it('refuses a key the policy does not list as a release key, including a maintainer key', async () => {
        await expect(signRelease({ payload, provenance: '{}', seed: seed(9), policy })).rejects.toThrow(
            ReleaseKeyError,
        );
        await expect(signRelease({ payload, provenance: '{}', seed: seed(2), policy })).rejects.toThrow(
            ReleaseKeyError,
        );
    });

    it('refuses empty provenance', async () => {
        await expect(signRelease({ payload, provenance: '', seed: seed(1), policy })).rejects.toThrow();
    });
});

describe('releaseSignerFromSeed', () => {
    it.each([
        ['standard base64', Buffer.alloc(32, 1).toString('base64')],
        ['31 bytes', encodeBase64Url(new Uint8Array(31))],
        ['garbage', 'not a key'],
    ])('refuses %s', async (_case, value) => {
        await expect(releaseSignerFromSeed(value)).rejects.toThrow(ReleaseKeyError);
    });

    it('ignores surrounding whitespace, as secrets often carry a newline', async () => {
        const signer = await releaseSignerFromSeed(`${seed(1)}\n`);
        expect(signer.publicKey()).toHaveLength(32);
    });
});
