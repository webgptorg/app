import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeBase64Std } from '../base64std';
import { utf8Encode } from '../bytes';
import { createFixedClock } from '../clock';
import type { ReleaseTestKeys } from '../testing/release';
import { entryJson, releaseTestKeys, testPolicy, testRelease, testRevocations } from '../testing/release';
import type { DsseEnvelope as DsseEnvelopeType } from './dsse';
import { DsseEnvelope, RELEASE_PAYLOAD_TYPE, REVOCATION_PAYLOAD_TYPE, signDsse } from './dsse';
import { SignedRelease, parseReleaseEntry } from './entry';
import { createFakeProvenanceVerifier } from './fake-provenance-verifier';
import { UiBundleManifest } from './manifest';
import { RevocationList, parseRevocationList } from './revocation';
import type { TrustPolicy } from './trust';
import type { ReleaseVerification } from './verify';
import { verifyRelease } from './verify';
import vectors from './vectors.json';

const OUTCOMES: readonly ReleaseVerification['kind'][] = [
    'ok',
    'invalid-entry',
    'signature-threshold-not-met',
    'not-in-log',
    'revocations-unverifiable',
    'revoked',
    'not-newer',
    'delay-not-elapsed',
];

let keys: ReleaseTestKeys;
let policy: TrustPolicy;
let revocations: DsseEnvelopeType;

beforeAll(async () => {
    keys = await releaseTestKeys();
    policy = testPolicy(keys);
    revocations = await testRevocations({ signers: [keys.release] });
});

async function verify(release: unknown, revocationList: unknown = revocations): Promise<ReleaseVerification> {
    const { attestation } = await testRelease({ signers: [keys.release] });
    return verifyRelease(
        {
            release,
            revocations: revocationList,
            lastAcceptedRevocationIssuedAt: null,
            policy,
            mode: 'auto',
            installedVersion: null,
            firstSeenAt: new Date('2026-10-01T12:10:00Z'),
        },
        {
            provenance: createFakeProvenanceVerifier([attestation]),
            clock: createFixedClock(new Date('2026-10-10T00:00:00Z')),
        },
    );
}

const keyIds = vectors.keys.map(({ keyid }) => keyid);
const signature = fc.record({
    keyid: fc.oneof(fc.constantFrom(...keyIds), fc.string()),
    sig: fc.oneof(
        fc.uint8Array({ minLength: 64, maxLength: 64 }).map((bytes) => encodeBase64Std(bytes)),
        fc.string(),
    ),
});
const envelopeLike = fc.record({
    payloadType: fc.oneof(fc.constantFrom(RELEASE_PAYLOAD_TYPE, REVOCATION_PAYLOAD_TYPE), fc.string()),
    payload: fc.oneof(
        fc.jsonValue().map((value) => encodeBase64Std(utf8Encode(JSON.stringify(value)))),
        fc.uint8Array().map((bytes) => encodeBase64Std(bytes)),
        fc.string(),
    ),
    signatures: fc.array(signature, { maxLength: 4 }),
});

describe('parsing never throws (property)', () => {
    it('on arbitrary JSON values', () => {
        fc.assert(
            fc.property(fc.jsonValue(), (value) => {
                for (const schema of [DsseEnvelope, SignedRelease, RevocationList, UiBundleManifest]) {
                    expect(() => schema.safeParse(value)).not.toThrow();
                }
                const bytes = utf8Encode(JSON.stringify(value));
                expect(() => parseReleaseEntry(bytes)).not.toThrow();
                expect(() => parseRevocationList(bytes)).not.toThrow();
            }),
        );
    });

    it('on arbitrary payload bytes', () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
                expect(parseReleaseEntry(Uint8Array.from(bytes))).toBeUndefined();
                expect(parseRevocationList(Uint8Array.from(bytes))).toBeUndefined();
            }),
        );
    });
});

describe('verifyRelease never throws (property)', () => {
    it('on arbitrary JSON as release and revocation list', async () => {
        await fc.assert(
            fc.asyncProperty(fc.jsonValue(), fc.jsonValue(), async (release, list) => {
                expect(OUTCOMES).toContain((await verify(release, list)).kind);
            }),
            { numRuns: 200 },
        );
    });

    it('on envelope-shaped values with arbitrary payloads, key IDs and signatures', async () => {
        await fc.assert(
            fc.asyncProperty(envelopeLike, envelopeLike, fc.string(), async (envelope, list, provenance) => {
                const result = await verify({ v: 1, envelope, provenance }, list);
                expect(OUTCOMES).toContain(result.kind);
                expect(result.kind).not.toBe('ok');
            }),
            { numRuns: 200 },
        );
    });

    it('on arbitrary JSON payloads signed by the release key', async () => {
        await fc.assert(
            fc.asyncProperty(fc.jsonValue(), async (value) => {
                const payload = utf8Encode(JSON.stringify(value));
                const envelope = await signDsse(keys.release, RELEASE_PAYLOAD_TYPE, payload);
                expect(await verify({ v: 1, envelope, provenance: '{}' })).toEqual({ kind: 'invalid-entry' });
            }),
            { numRuns: 100 },
        );
    });

    it('on entries with arbitrary field values signed by the release key', async () => {
        const field = fc.oneof(fc.jsonValue(), fc.string(), fc.constant(null));
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom('version', 'gitTag', 'commit', 'artifacts', 'kind', 'advisory', 'publishedAt'),
                field,
                async (name, value) => {
                    const { release } = await testRelease({
                        signers: [keys.release],
                        entry: { ...entryJson(), [name]: value },
                    });
                    expect(OUTCOMES).toContain((await verify(release)).kind);
                },
            ),
            { numRuns: 100 },
        );
    });
});
