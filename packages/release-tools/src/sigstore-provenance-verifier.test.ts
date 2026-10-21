import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Bytes, ExpectedWorkflowClaims, FulcioOid, ProvenanceVerification } from '@ptbk/protocol';
import { FULCIO_OID, GITHUB_ACTIONS_ISSUER, WorkflowIdentity, expectedWorkflowClaims } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import {
    FULCIO_ISSUER_V2_OID,
    createSigstoreProvenanceVerifier,
    decodeDerUtf8String,
    latestVerifiedTime,
    readCertificateClaims,
} from './sigstore-provenance-verifier';
import { PINNED_TRUSTED_ROOT } from './trusted-root';

const here = import.meta.dirname;
const verifier = createSigstoreProvenanceVerifier(PINNED_TRUSTED_ROOT);

interface Fixture {
    readonly text: string;
    readonly json: Record<string, unknown>;
    readonly envelope: { readonly payloadType: string; readonly payload: Bytes };
    readonly leafDer: Uint8Array;
}

interface BundleShape {
    mediaType: string;
    dsseEnvelope?: { payloadType: string; payload: string; signatures: { sig: string }[] };
    messageSignature?: unknown;
    verificationMaterial: {
        certificate?: { rawBytes: string };
        x509CertificateChain?: { certificates: { rawBytes: string }[] };
        publicKey?: { hint: string };
        tlogEntries: unknown[];
    };
}

function load(name: string): Fixture {
    const text = readFileSync(join(here, 'fixtures', `${name}.sigstore.json`), 'utf8');
    const json = JSON.parse(text) as Record<string, unknown>;
    const shape = json as unknown as Required<BundleShape>;
    return {
        text,
        json,
        envelope: {
            payloadType: shape.dsseEnvelope.payloadType,
            payload: new Uint8Array(Buffer.from(shape.dsseEnvelope.payload, 'base64')),
        },
        leafDer: new Uint8Array(Buffer.from(shape.verificationMaterial.certificate?.rawBytes ?? '', 'base64')),
    };
}

function edited(fixture: Fixture, edit: (bundle: BundleShape) => void): string {
    const copy = structuredClone(fixture.json) as unknown as BundleShape;
    edit(copy);
    return JSON.stringify(copy);
}

const hono = load('hono-4.13.13');
const vite = load('vite-8.3.4');

const HONO_COMMIT = '08a023cbfde55b434fb0fb30fae35d42e4bf20aa';
const honoIdentity = WorkflowIdentity.parse({
    issuer: GITHUB_ACTIONS_ISSUER,
    repository: 'honojs/hono',
    repositoryId: '438384984',
    workflowPath: '.github/workflows/release.yml',
});
const honoEntry = { gitTag: 'v4.13.13', commit: HONO_COMMIT } as const;
const honoExpected = expectedWorkflowClaims(honoIdentity, honoEntry);

// vite publishes from a branch, which `expectedWorkflowClaims` never produces; the port takes claims, so they are
// spelled out from its certificate.
const VITE_SAN = 'https://github.com/vitejs/vite/.github/workflows/publish.yml@refs/heads/main';
const viteExpected: ExpectedWorkflowClaims = {
    issuer: GITHUB_ACTIONS_ISSUER,
    subjectAlternativeName: VITE_SAN,
    subjectAlternativeNamePattern: 'unused',
    extensions: {
        [FULCIO_OID.runnerEnvironment]: 'github-hosted',
        [FULCIO_OID.sourceRepositoryDigest]: 'b6c20f6a8126d8561891e5fb9368e8fc9da37538',
        [FULCIO_OID.sourceRepositoryRef]: 'refs/heads/main',
        [FULCIO_OID.sourceRepositoryIdentifier]: '257485422',
        [FULCIO_OID.buildTrigger]: 'push',
    },
};

function signal(): AbortSignal {
    return new AbortController().signal;
}

async function verify(
    text: string,
    expected: ExpectedWorkflowClaims = honoExpected,
    envelope: Fixture['envelope'] = hono.envelope,
): Promise<ProvenanceVerification> {
    return verifier.verifyProvenance(text, envelope, expected, signal());
}

function withExtension(oid: FulcioOid, value: string): ExpectedWorkflowClaims {
    return { ...honoExpected, extensions: { ...honoExpected.extensions, [oid]: value } };
}

describe('createSigstoreProvenanceVerifier', () => {
    it('verifies a real tag-push attestation against the exact expected identity', async () => {
        expect(await verify(hono.text)).toEqual({
            kind: 'verified',
            logIndex: 3076326982,
            trustedTime: new Date('2026-10-04T03:48:21.000Z'),
        });
    });

    it('returns the later of the TSA time and the Rekor integrated time', async () => {
        // Rekor integrated 12:03:46, the TSA signed 12:03:49.
        expect(await verify(vite.text, viteExpected, vite.envelope)).toEqual({
            kind: 'verified',
            logIndex: 3147751755,
            trustedTime: new Date('2026-10-08T12:03:49.000Z'),
        });
    });

    it.each([
        ['repository', expectedWorkflowClaims({ ...honoIdentity, repository: 'honojs/hono2' }, honoEntry)],
        ['repository ID', expectedWorkflowClaims({ ...honoIdentity, repositoryId: '438384985' }, honoEntry)],
        [
            'workflow path',
            expectedWorkflowClaims({ ...honoIdentity, workflowPath: '.github/workflows/publish.yml' }, honoEntry),
        ],
        ['tag', expectedWorkflowClaims(honoIdentity, { ...honoEntry, gitTag: 'v4.13.12' })],
        ['commit', expectedWorkflowClaims(honoIdentity, { ...honoEntry, commit: '0'.repeat(40) })],
        ['runner', withExtension(FULCIO_OID.runnerEnvironment, 'self-hosted')],
        ['trigger', withExtension(FULCIO_OID.buildTrigger, 'workflow_dispatch')],
        ['ref', withExtension(FULCIO_OID.sourceRepositoryRef, 'refs/heads/main')],
        ['issuer', { ...honoExpected, issuer: 'https://accounts.google.com' }],
        ['SAN with a prefix', { ...honoExpected, subjectAlternativeName: `x${honoExpected.subjectAlternativeName}` }],
        ['SAN with a suffix', { ...honoExpected, subjectAlternativeName: `${honoExpected.subjectAlternativeName}x` }],
        [
            'SAN that is only a prefix of the real one',
            { ...honoExpected, subjectAlternativeName: honoExpected.subjectAlternativeName.slice(0, -1) },
        ],
    ])('refuses another %s', async (_, expected) => {
        const result = await verify(hono.text, expected);
        expect(result.kind).toBe('invalid');
        expect(result).toMatchObject({ reason: expect.stringMatching(/^identity-mismatch:/) as unknown });
    });

    it('refuses an envelope whose payload or payload type differs by one byte', async () => {
        const payload = hono.envelope.payload.slice();
        payload[10] = (payload[10] ?? 0) ^ 1;
        expect(await verify(hono.text, honoExpected, { ...hono.envelope, payload })).toEqual({
            kind: 'invalid',
            reason: 'payload-mismatch',
        });
        expect(
            await verify(hono.text, honoExpected, { ...hono.envelope, payloadType: `${hono.envelope.payloadType} ` }),
        ).toEqual({ kind: 'invalid', reason: 'payload-mismatch' });
    });

    it('refuses a bundle whose signature or signed payload was tampered with', async () => {
        const signature = edited(hono, (bundle) => {
            const envelope = bundle.dsseEnvelope;
            const sig = Buffer.from(envelope?.signatures[0]?.sig ?? '', 'base64');
            sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 1;
            if (envelope !== undefined)
                envelope.signatures = [{ ...envelope.signatures[0], sig: sig.toString('base64') }];
        });
        expect((await verify(signature)).kind).toBe('invalid');

        const payload = Buffer.from(hono.envelope.payload);
        payload[10] = (payload[10] ?? 0) ^ 1;
        const tamperedPayload = edited(hono, (bundle) => {
            if (bundle.dsseEnvelope !== undefined) bundle.dsseEnvelope.payload = payload.toString('base64');
        });
        const envelope = { ...hono.envelope, payload: new Uint8Array(payload) };
        expect((await verify(tamperedPayload, honoExpected, envelope)).kind).toBe('invalid');
    });

    it('refuses a bundle without a transparency log entry', async () => {
        // hono has no other timestamp, so nothing can anchor its certificate's validity: invalid.
        const honoUnlogged = edited(hono, (bundle) => {
            bundle.verificationMaterial.tlogEntries = [];
        });
        expect((await verify(honoUnlogged)).kind).toBe('invalid');

        // vite still has its TSA timestamp: a valid signature that was never logged.
        const viteUnlogged = edited(vite, (bundle) => {
            bundle.verificationMaterial.tlogEntries = [];
        });
        expect(await verify(viteUnlogged, viteExpected, vite.envelope)).toEqual({
            kind: 'not-in-log',
            reason: 'no-tlog-entry',
        });
    });

    it('refuses an unlogged bundle whose identity does not match as invalid, not as not-in-log', async () => {
        const viteUnlogged = edited(vite, (bundle) => {
            bundle.verificationMaterial.tlogEntries = [];
        });
        expect(await verify(viteUnlogged, honoExpected, vite.envelope)).toMatchObject({ kind: 'invalid' });
    });

    it('accepts the leaf certificate as a one-element chain', async () => {
        const chain = edited(hono, (bundle) => {
            const { certificate, tlogEntries } = bundle.verificationMaterial;
            bundle.verificationMaterial = {
                x509CertificateChain: { certificates: [certificate ?? { rawBytes: '' }] },
                tlogEntries,
            };
            bundle.mediaType = 'application/vnd.dev.sigstore.bundle+json;version=0.2';
        });
        expect((await verify(chain)).kind).toBe('verified');
    });

    it('refuses a bundle that carries a public key instead of a certificate', async () => {
        const keyed = edited(hono, (bundle) => {
            delete bundle.verificationMaterial.certificate;
            bundle.verificationMaterial.publicKey = { hint: 'x' };
        });
        expect(await verify(keyed)).toEqual({ kind: 'invalid', reason: 'no-certificate' });
    });

    it('refuses a message signature bundle', async () => {
        const message = edited(hono, (bundle) => {
            delete bundle.dsseEnvelope;
            bundle.messageSignature = {
                messageDigest: { algorithm: 'SHA2_256', digest: Buffer.alloc(32).toString('base64') },
                signature: Buffer.alloc(64).toString('base64'),
            };
        });
        expect(await verify(message)).toEqual({ kind: 'invalid', reason: 'not-a-dsse-bundle' });
    });

    it.each(['', 'not json', 'null', '[]', '{}', '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}'])(
        'answers %j with invalid instead of throwing',
        async (text) => {
            expect(await verify(text)).toEqual({ kind: 'invalid', reason: 'malformed-bundle' });
        },
    );

    it('rejects when aborted', async () => {
        const controller = new AbortController();
        controller.abort(new Error('stop'));
        await expect(
            verifier.verifyProvenance(hono.text, hono.envelope, honoExpected, controller.signal),
        ).rejects.toThrow('stop');
    });
});

describe('readCertificateClaims', () => {
    const utf8String = (text: string): Buffer => {
        const bytes = Buffer.from(text, 'utf8');
        return Buffer.concat([Buffer.from([0x0c, bytes.length]), bytes]);
    };
    const oid = (id: string) => ({ id: id.split('.').map(Number) });
    const honoSan = honoExpected.subjectAlternativeName;
    const signer = (oids: { oid: { id: number[] }; value: Buffer }[], san = honoSan) => ({
        identity: { subjectAlternativeName: san, oids },
    });
    const issuer = { oid: oid(FULCIO_ISSUER_V2_OID), value: utf8String(GITHUB_ACTIONS_ISSUER) };

    it('reads the issuer and the Fulcio extensions as exact strings', () => {
        const result = readCertificateClaims(
            signer([issuer, { oid: oid(FULCIO_OID.buildTrigger), value: utf8String('push') }]),
            hono.leafDer,
        );
        expect(result).toEqual({
            kind: 'ok',
            claims: {
                issuer: GITHUB_ACTIONS_ISSUER,
                subjectAlternativeName: honoSan,
                extensions: new Map([
                    [FULCIO_ISSUER_V2_OID, GITHUB_ACTIONS_ISSUER],
                    [FULCIO_OID.buildTrigger, 'push'],
                ]),
            },
        });
    });

    it('refuses a SAN that is not exactly the certificate’s single URI', () => {
        expect(readCertificateClaims(signer([issuer], `${honoSan}x`), hono.leafDer)).toEqual({
            kind: 'invalid',
            reason: 'san-not-a-single-uri',
        });
        expect(readCertificateClaims({ identity: { oids: [issuer] } }, hono.leafDer)).toMatchObject({
            kind: 'invalid',
        });
        expect(readCertificateClaims({}, hono.leafDer)).toMatchObject({ kind: 'invalid' });
    });

    it('refuses a duplicated extension', () => {
        expect(readCertificateClaims(signer([issuer, issuer]), hono.leafDer)).toEqual({
            kind: 'invalid',
            reason: 'duplicate-extension',
        });
    });

    it('refuses a required extension that is not a DER UTF8String', () => {
        const printable = Buffer.concat([Buffer.from([0x13, 4]), Buffer.from('push')]);
        const result = readCertificateClaims(
            signer([issuer, { oid: oid(FULCIO_OID.buildTrigger), value: printable }]),
            hono.leafDer,
        );
        expect(result).toEqual({ kind: 'invalid', reason: `extension-not-utf8string:${FULCIO_OID.buildTrigger}` });
    });

    it('ignores extensions it does not check, whatever their encoding', () => {
        const result = readCertificateClaims(
            signer([issuer, { oid: oid('1.3.6.1.4.1.57264.1.1'), value: Buffer.from('raw') }]),
            hono.leafDer,
        );
        expect(result.kind).toBe('ok');
    });

    it('refuses a certificate without the v2 issuer extension', () => {
        expect(readCertificateClaims(signer([]), hono.leafDer)).toEqual({ kind: 'invalid', reason: 'missing-issuer' });
        expect(readCertificateClaims({ identity: { subjectAlternativeName: honoSan } }, hono.leafDer)).toEqual({
            kind: 'invalid',
            reason: 'missing-issuer',
        });
    });
});

describe('decodeDerUtf8String', () => {
    const der = (...bytes: number[]) => Uint8Array.from(bytes);

    it('decodes short and long definite lengths', () => {
        expect(decodeDerUtf8String(der(0x0c, 0x04, 0x70, 0x75, 0x73, 0x68))).toBe('push');
        expect(decodeDerUtf8String(der(0x0c, 0x00))).toBe('');
        const long = 'a'.repeat(200);
        expect(decodeDerUtf8String(Uint8Array.from([0x0c, 0x81, 200, ...Buffer.from(long)]))).toBe(long);
        const longer = 'b'.repeat(300);
        expect(decodeDerUtf8String(Uint8Array.from([0x0c, 0x82, 0x01, 0x2c, ...Buffer.from(longer)]))).toBe(longer);
        expect(decodeDerUtf8String(Uint8Array.from([0x0c, 0x03, ...Buffer.from('é', 'utf8'), 0x21]))).toBe('é!');
    });

    it('keeps a byte order mark instead of stripping it', () => {
        expect(decodeDerUtf8String(der(0x0c, 0x04, 0xef, 0xbb, 0xbf, 0x61))).toBe('﻿a');
    });

    it.each([
        ['empty input', der()],
        ['a lone tag', der(0x0c)],
        ['a PrintableString', der(0x13, 0x01, 0x61)],
        ['an IA5String', der(0x16, 0x01, 0x61)],
        ['an OCTET STRING', der(0x04, 0x01, 0x61)],
        ['a trailing byte', der(0x0c, 0x01, 0x61, 0x00)],
        ['a truncated value', der(0x0c, 0x02, 0x61)],
        ['the indefinite length', der(0x0c, 0x80, 0x61, 0x00, 0x00)],
        ['a non-minimal one-byte long form', der(0x0c, 0x81, 0x01, 0x61)],
        ['a non-minimal two-byte long form', Uint8Array.from([0x0c, 0x82, 0x00, 0x81, ...Buffer.alloc(0x81, 0x61)])],
        ['three length bytes', der(0x0c, 0x83, 0x00, 0x00, 0x01, 0x61)],
        ['missing length bytes', der(0x0c, 0x82, 0x01)],
        ['invalid UTF-8', der(0x0c, 0x02, 0xc3, 0x28)],
        ['an overlong encoding', der(0x0c, 0x02, 0xc0, 0xaf)],
    ])('refuses %s', (_, bytes) => {
        expect(decodeDerUtf8String(bytes)).toBeUndefined();
    });
});

describe('latestVerifiedTime', () => {
    const tsa = (iso: string) => ({ $case: 'timestamp-authority', timestamp: { signingTime: new Date(iso) } });
    const tlog = (seconds: string, promised = true) => ({
        $case: 'transparency-log',
        tlogEntry: promised ? { integratedTime: seconds, inclusionPromise: {} } : { integratedTime: seconds },
    });
    type Timestamps = Parameters<typeof latestVerifiedTime>[0];
    const latest = (...timestamps: unknown[]) => latestVerifiedTime(timestamps as Timestamps);

    it('is null without any verified timestamp', () => {
        expect(latest()).toBeNull();
        expect(latest(tlog('1791085701', false))).toBeNull();
    });

    it('picks the later of a TSA time and a Rekor integrated time, whichever it is', () => {
        expect(latest(tlog('1000'), tsa('1970-01-01T00:20:00.000Z'))).toEqual(new Date(1_200_000));
        expect(latest(tsa('1970-01-01T00:10:00.000Z'), tlog('1000'))).toEqual(new Date(1_000_000));
    });

    it('ignores an integrated time without an inclusion promise, which nothing verified', () => {
        expect(latest(tsa('1970-01-01T00:10:00.000Z'), tlog('9000', false))).toEqual(new Date(600_000));
    });

    it('ignores a time that is not a number', () => {
        expect(latest(tlog('soon'), tsa('1970-01-01T00:00:01.000Z'))).toEqual(new Date(1000));
    });
});
