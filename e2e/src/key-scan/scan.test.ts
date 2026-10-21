import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { findSecretForms, privateKeysIn, publicKeySpkiSha256, scanTarStream, scanText } from './scan.ts';
import { ed25519PrivateKeyForms } from './secret-forms.ts';
import { chunked, tarArchive } from './testing/tar-writer.ts';

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecPem = ec.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaPem = rsa.privateKey.export({ format: 'pem', type: 'pkcs1' }).toString();
const encryptedPem = ec.privateKey
    .export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'test passphrase' })
    .toString();

const identity = generateKeyPairSync('ed25519').privateKey;
const identityPem = identity.export({ format: 'pem', type: 'pkcs8' }).toString();
const identityForms = ed25519PrivateKeyForms('engine identity key', identityPem);
const seedBase64url = identity.export({ format: 'jwk' }).d ?? '';
// Hex, because a random seed's base64 and base64url coincide whenever neither has `+`, `/`, `-` or `_`.
const seedHex = Buffer.from(seedBase64url, 'base64url').toString('hex');

function bytes(text: string): Buffer {
    return Buffer.from(text, 'utf8');
}

describe('privateKeysIn', () => {
    it('finds PKCS#8 EC and PKCS#1 RSA keys with the SPKI hash of their public key', () => {
        expect(privateKeysIn('keys', bytes(`${ecPem}\nnoise\n${rsaPem}`))).toEqual([
            {
                status: 'parsed',
                label: 'keys',
                type: 'PRIVATE KEY',
                keyType: 'ec',
                publicKeySpkiSha256: publicKeySpkiSha256(ec.publicKey),
            },
            {
                status: 'parsed',
                label: 'keys',
                type: 'RSA PRIVATE KEY',
                keyType: 'rsa',
                publicKeySpkiSha256: publicKeySpkiSha256(createPublicKey(rsaPem)),
            },
        ]);
    });

    it('reports an encrypted key without parsing it', () => {
        expect(privateKeysIn('enc', bytes(encryptedPem))).toEqual([
            { status: 'encrypted', label: 'enc', type: 'ENCRYPTED PRIVATE KEY' },
        ]);
    });

    it('finds a key inside a JSON string and inside a binary', () => {
        const json = bytes(JSON.stringify({ tls: { key: ecPem } }));
        const binary = Buffer.concat([Buffer.from([0, 255, 1]), bytes(ecPem), Buffer.from([0, 7])]);
        for (const haystack of [json, binary]) {
            expect(privateKeysIn('x', haystack)).toMatchObject([
                { status: 'parsed', publicKeySpkiSha256: publicKeySpkiSha256(ec.publicKey) },
            ]);
        }
    });

    it('reports a complete block it cannot parse', () => {
        const broken = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIAAAAAAAAAAA\n-----END EC PRIVATE KEY-----';
        expect(privateKeysIn('broken', bytes(broken))).toEqual([
            { status: 'unparseable', label: 'broken', type: 'EC PRIVATE KEY' },
        ]);
    });

    it('ignores markers without a body or END line, as in source code', () => {
        const source = [
            "const HEADER = '-----BEGIN PRIVATE KEY-----';",
            "const pem = '-----BEGIN PRIVATE KEY-----\\n' + body + '\\n-----END PRIVATE KEY-----';",
            '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----',
            '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
        ].join('\n');
        expect(privateKeysIn('lib.js', bytes(source))).toEqual([]);
    });
});

describe('findSecretForms', () => {
    it('names the haystack, secret and form of each match', () => {
        expect(findSecretForms({ label: 'env:KEY', bytes: bytes(`KEY=${seedHex}`) }, identityForms)).toEqual([
            { label: 'env:KEY', secret: 'engine identity key', form: 'seed, hex' },
        ]);
    });

    it('searches a view into a larger buffer only within the view', () => {
        const whole = bytes(`${seedBase64url}|clean`);
        const view = whole.subarray(seedBase64url.length + 1);
        expect(findSecretForms({ label: 'view', bytes: view }, identityForms)).toEqual([]);
    });
});

describe('scanText', () => {
    it('checks text for needles and private keys', () => {
        expect(scanText('inspect', JSON.stringify({ Env: [`KEY=${identityPem}`] }), identityForms)).toEqual({
            findings: [
                { label: 'inspect', secret: 'engine identity key', form: 'PKCS#8 DER, base64' },
                { label: 'inspect', secret: 'engine identity key', form: 'PKCS#8 PEM, first line' },
            ],
            privateKeys: [expect.objectContaining({ status: 'parsed', keyType: 'ed25519' })],
        });
    });
});

describe('scanTarStream', () => {
    const tar = tarArchive([
        { name: 'app/', typeflag: '5' },
        { name: 'app/tls/key.pem', content: ecPem },
        { name: 'app/config.json', content: JSON.stringify({ identity: seedHex }) },
        { name: 'app/link', typeflag: '2', linkname: 'tls/key.pem' },
    ]);

    it('scans every regular file and counts them', async () => {
        const report = await scanTarStream('relay-a', chunked(tar, 7), identityForms);
        expect(report).toEqual({
            findings: [{ label: 'relay-a:app/config.json', secret: 'engine identity key', form: 'seed, hex' }],
            privateKeys: [expect.objectContaining({ label: 'relay-a:app/tls/key.pem', status: 'parsed' })],
            filesScanned: 2,
            bytesScanned: ecPem.length + JSON.stringify({ identity: seedHex }).length,
        });
    });

    it('never puts secret bytes into a result', async () => {
        const report = await scanTarStream(
            'relay-a',
            chunked(tarArchive([{ name: 'leak', content: identityPem }]), 4096),
            identityForms,
        );
        expect(report.findings.length).toBeGreaterThan(0);
        const serialised = JSON.stringify(report);
        for (const needle of identityForms) {
            expect(serialised).not.toContain(Buffer.from(needle.bytes).toString('latin1'));
        }
        expect(serialised).not.toContain(seedBase64url);
        expect(serialised).not.toContain(seedHex);
    });

    it('fails on a corrupt archive instead of reporting a clean scan', async () => {
        await expect(scanTarStream('relay-a', chunked(tar.subarray(0, 1500), 512), identityForms)).rejects.toThrow(
            'truncated archive',
        );
    });
});
