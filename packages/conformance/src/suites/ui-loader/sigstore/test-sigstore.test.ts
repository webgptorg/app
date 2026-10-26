import { FULCIO_OID, decodeBase64Std, utf8Encode } from '@ptbk/protocol';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import type { SignedEntity, Signer } from '@sigstore/verify';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';
import { describe, expect, it } from 'vitest';

import { ecdsaSignatureToDer, generalizedTime, integer, oid, utf8String, x509Time } from './der';
import type { TestAttestation } from './test-sigstore';
import { createTestSigstore } from './test-sigstore';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';
const SAN = 'https://github.com/example/ui/.github/workflows/release.yml@refs/tags/v1.2.3';
const CLAIMS = {
    [FULCIO_OID.runnerEnvironment]: 'github-hosted',
    [FULCIO_OID.sourceRepositoryDigest]: 'a'.repeat(40),
    [FULCIO_OID.sourceRepositoryRef]: 'refs/tags/v1.2.3',
    [FULCIO_OID.sourceRepositoryIdentifier]: '123456789',
    [FULCIO_OID.buildTrigger]: 'push',
};

const sigstore = await createTestSigstore({ now: NOW });
const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(sigstore.trustedRoot)), {
    tlogThreshold: 1,
    ctlogThreshold: 1,
});

function attestation(overrides: Partial<TestAttestation> = {}): TestAttestation {
    return {
        payloadType: 'application/vnd.in-toto+json',
        payload: utf8Encode('{"_type":"https://in-toto.io/Statement/v1"}'),
        certificate: {
            issuer: 'https://token.actions.githubusercontent.com',
            subjectAlternativeName: SAN,
            extensions: CLAIMS,
        },
        integratedTime: new Date(NOW.getTime() + 1_500),
        logIndex: 4_242,
        ...overrides,
    };
}

function entity(json: string): SignedEntity {
    return toSignedEntity(bundleFromJSON(JSON.parse(json)));
}

function verify(json: string): Signer {
    return verifier.verify(entity(json));
}

function failure(json: string): string {
    try {
        verify(json);
    } catch (error) {
        return (error as { code?: string }).code ?? String(error);
    }
    return 'verified';
}

interface BundleShape {
    dsseEnvelope: { payload: string };
    verificationMaterial: {
        tlogEntries: {
            inclusionPromise?: { signedEntryTimestamp: string };
            inclusionProof: { rootHash: string; checkpoint: { envelope: string } };
        }[];
    };
}

function edited(json: string, edit: (bundle: BundleShape) => void): string {
    const bundle = JSON.parse(json) as BundleShape;
    edit(bundle);
    return JSON.stringify(bundle);
}

function flipLastByte(base64: string): string {
    const decoded = decodeBase64Std(base64);
    if (decoded.kind !== 'ok') throw new Error('not base64');
    const bytes = decoded.bytes.slice();
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    return btoa(String.fromCharCode(...bytes));
}

// Node hands out Buffers, which never deep-equal a plain Uint8Array.
function oidValues(signer: Signer): Map<string, Uint8Array> {
    return new Map(
        (signer.identity?.oids ?? []).map(({ oid: id, value }) => [(id?.id ?? []).join('.'), new Uint8Array(value)]),
    );
}

function firstEntry(bundle: BundleShape): BundleShape['verificationMaterial']['tlogEntries'][number] {
    const entry = bundle.verificationMaterial.tlogEntries[0];
    if (entry === undefined) throw new Error('no tlog entry');
    return entry;
}

describe('createTestSigstore', () => {
    it('publishes a trusted root with one Fulcio CA, Rekor log, CT log and TSA', () => {
        const root = TrustedRoot.fromJSON(sigstore.trustedRoot);
        expect(root.mediaType).toBe('application/vnd.dev.sigstore.trustedroot+json;version=0.1');
        expect(
            [root.certificateAuthorities, root.tlogs, root.ctlogs, root.timestampAuthorities].map(
                (part) => part.length,
            ),
        ).toEqual([1, 1, 1, 1]);
        expect(Object.isFrozen(sigstore.trustedRoot)).toBe(true);
    });

    it('mints a v0.3 DSSE bundle that verifies with one SCT and one Rekor entry', async () => {
        const json = await sigstore.attest(attestation());
        const bundle = bundleFromJSON(JSON.parse(json));
        expect(bundle.mediaType).toBe('application/vnd.dev.sigstore.bundle.v0.3+json');
        expect(bundle.content.$case).toBe('dsseEnvelope');

        const signed = entity(json);
        const signer = verifier.verify(signed);
        expect(signer.identity?.subjectAlternativeName).toBe(SAN);
        expect(signer.identity?.extensions?.issuer).toBe('https://token.actions.githubusercontent.com');
        const values = oidValues(signer);
        expect(values.get(ISSUER_V2)).toEqual(utf8String('https://token.actions.githubusercontent.com'));
        for (const [id, value] of Object.entries(CLAIMS)) expect(values.get(id)).toEqual(utf8String(value));

        const entry = signed.tlogEntries[0];
        expect(entry?.logIndex).toBe('4242');
        expect(entry?.integratedTime).toBe(String(Math.floor(NOW.getTime() / 1000) + 1));
        expect(entry?.inclusionPromise).toBeDefined();
        expect(signed.timestamps.map((timestamp) => timestamp.$case)).toEqual(['transparency-log']);
    });

    it('builds a valid inclusion proof for any log index', async () => {
        for (const logIndex of [0, 1, 2 ** 40 - 1]) {
            expect(failure(await sigstore.attest(attestation({ logIndex })))).toBe('verified');
        }
    });

    it('adds RFC 3161 timestamps the verifier checks against the TSA', async () => {
        const tsaTime = new Date(NOW.getTime() + 60_000);
        const signed = entity(await sigstore.attest(attestation({ tsaTimes: [tsaTime] })));
        verifier.verify(signed);
        const tsa = signed.timestamps.find((timestamp) => timestamp.$case === 'timestamp-authority');
        expect(tsa?.$case === 'timestamp-authority' ? tsa.timestamp.signingTime : undefined).toEqual(tsaTime);
    });

    it('leaves the integrated time unverified without an inclusion promise', async () => {
        const tsaTime = new Date(NOW.getTime() + 5_000);
        const json = await sigstore.attest(attestation({ omitInclusionPromise: true, tsaTimes: [tsaTime] }));
        const signed = entity(json);
        verifier.verify(signed);
        expect(signed.tlogEntries[0]?.inclusionPromise).toBeUndefined();
        expect(signed.timestamps.map((timestamp) => timestamp.$case)).toEqual([
            'transparency-log',
            'timestamp-authority',
        ]);

        expect(failure(await sigstore.attest(attestation({ omitInclusionPromise: true })))).toBe('TIMESTAMP_ERROR');
    });

    it('writes raw-octet extension values that are not a DER UTF8String', async () => {
        const signer = verify(await sigstore.attest(attestation({ extensionEncoding: 'raw-octets' })));
        const values = oidValues(signer);
        expect(values.get(ISSUER_V2)).toEqual(utf8Encode('https://token.actions.githubusercontent.com'));
        for (const [id, value] of Object.entries(CLAIMS)) {
            expect(values.get(id)).toEqual(utf8Encode(value));
            expect(values.get(id)?.[0]).not.toBe(0x0c);
        }
    });

    it.each<[string, Partial<TestAttestation>, string]>([
        ['a certificate from a CA outside the trusted root', { untrustedCa: true }, 'CERTIFICATE_ERROR'],
        ['a certificate without an SCT', { omitSct: true }, 'CERTIFICATE_ERROR'],
        ['a bundle without a Rekor entry or other timestamp', { omitTlogEntry: true }, 'TIMESTAMP_ERROR'],
        [
            'a bundle without a Rekor entry',
            { omitTlogEntry: true, tsaTimes: [new Date(NOW.getTime() + 1_000)] },
            'TLOG_ERROR',
        ],
        [
            'a TSA time after the ten-minute certificate expired',
            { tsaTimes: [new Date(NOW.getTime() + 11 * 60_000)] },
            'CERTIFICATE_ERROR',
        ],
    ])('is refused for %s', async (_, overrides, code) => {
        expect(failure(await sigstore.attest(attestation(overrides)))).toBe(code);
    });

    it('is refused when the SET, checkpoint, inclusion proof or payload is tampered with', async () => {
        const json = await sigstore.attest(attestation());
        const tamperedSet = edited(json, (bundle) => {
            const promise = firstEntry(bundle).inclusionPromise;
            if (promise !== undefined) promise.signedEntryTimestamp = flipLastByte(promise.signedEntryTimestamp);
        });
        expect(failure(tamperedSet)).toBe('TLOG_INCLUSION_PROMISE_ERROR');

        const tamperedCheckpoint = edited(json, (bundle) => {
            const checkpoint = firstEntry(bundle).inclusionProof.checkpoint;
            checkpoint.envelope = checkpoint.envelope.replace(' - 1\n', ' - 2\n');
        });
        expect(failure(tamperedCheckpoint)).toBe('TLOG_INCLUSION_PROOF_ERROR');

        const tamperedPayload = edited(json, (bundle) => {
            bundle.dsseEnvelope.payload = btoa('{"_type":"https://in-toto.io/Statement/v0"}');
        });
        expect(failure(tamperedPayload)).toBe('TLOG_BODY_ERROR');
    });

    it('refuses invalid inputs', async () => {
        await expect(sigstore.attest(attestation({ logIndex: -1 }))).rejects.toThrow(RangeError);
        await expect(sigstore.attest(attestation({ logIndex: 0.5 }))).rejects.toThrow(RangeError);
        await expect(sigstore.attest(attestation({ integratedTime: new Date(Number.NaN) }))).rejects.toThrow(
            RangeError,
        );
        await expect(createTestSigstore({ now: new Date(Number.NaN) })).rejects.toThrow(RangeError);
    });
});

describe('der', () => {
    it('encodes minimal unsigned integers', () => {
        expect(integer(0)).toEqual(Uint8Array.of(0x02, 0x01, 0x00));
        expect(integer(0x80)).toEqual(Uint8Array.of(0x02, 0x02, 0x00, 0x80));
        expect(integer(0x0100)).toEqual(Uint8Array.of(0x02, 0x02, 0x01, 0x00));
        expect(integer(Uint8Array.of(0, 0, 0x7f))).toEqual(Uint8Array.of(0x02, 0x01, 0x7f));
        expect(integer(Uint8Array.of(0, 0))).toEqual(Uint8Array.of(0x02, 0x01, 0x00));
        expect(() => integer(-1)).toThrow(RangeError);
    });

    it('encodes object identifiers with multi-byte arcs and refuses malformed ones', () => {
        expect(oid('1.2.840.10045.4.3.2')).toEqual(
            Uint8Array.of(0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02),
        );
        for (const bad of ['1', '3.1', '1.40', '1.x', '1.2.-3']) expect(() => oid(bad)).toThrow(RangeError);
    });

    it('uses long-form lengths beyond 127 bytes', () => {
        expect(utf8String('x'.repeat(200)).subarray(0, 3)).toEqual(Uint8Array.of(0x0c, 0x81, 200));
        expect(utf8String('x'.repeat(300)).subarray(0, 4)).toEqual(Uint8Array.of(0x0c, 0x82, 0x01, 0x2c));
    });

    it('writes UTCTime before 2050 and GeneralizedTime from 2050 on', () => {
        expect(x509Time(new Date('2049-12-31T23:59:59Z'))).toEqual(
            Uint8Array.of(0x17, 13, ...utf8Encode('491231235959Z')),
        );
        expect(x509Time(new Date('2050-01-01T00:00:00Z'))).toEqual(generalizedTime(new Date('2050-01-01T00:00:00Z')));
        expect(x509Time(new Date('1949-06-01T00:00:00Z'))[0]).toBe(0x18);
        expect(() => generalizedTime(new Date(Number.NaN))).toThrow(RangeError);
    });

    it('converts raw ECDSA signatures to DER', () => {
        const raw = new Uint8Array(64);
        raw[0] = 0x80;
        raw[63] = 0x01;
        const der = ecdsaSignatureToDer(raw);
        expect(der.subarray(0, 5)).toEqual(Uint8Array.of(0x30, 38, 0x02, 33, 0x00));
        expect(der.subarray(-3)).toEqual(Uint8Array.of(0x02, 0x01, 0x01));
        expect(() => ecdsaSignatureToDer(new Uint8Array(3))).toThrow(RangeError);
    });
});
