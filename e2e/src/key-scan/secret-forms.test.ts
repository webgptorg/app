import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { scanTarStream } from './scan.ts';
import {
    MIN_NEEDLE_BYTES,
    certificateForms,
    ecPrivateKeyForms,
    ed25519PrivateKeyForms,
    secretNeedle,
} from './secret-forms.ts';
import type { SecretNeedle } from './secret-forms.ts';
import { chunked, tarArchive } from './testing/tar-writer.ts';

function tlv(tag: number, ...parts: readonly Uint8Array[]): Buffer {
    const body = Buffer.concat(parts);
    const length =
        body.length < 0x80
            ? [body.length]
            : body.length < 0x100
              ? [0x81, body.length]
              : [0x82, body.length >> 8, body.length & 0xff];
    return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

/** Node cannot issue certificates, so the test signs a minimal self-signed one by hand: no fixture is checked in. */
function selfSignedCertificate(): { readonly der: Buffer; readonly keyPem: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecdsaWithSha256 = tlv(0x30, tlv(0x06, Buffer.from('2a8648ce3d040302', 'hex')));
    const name = tlv(
        0x30,
        tlv(0x31, tlv(0x30, tlv(0x06, Buffer.from('550403', 'hex')), tlv(0x0c, Buffer.from('key-scan')))),
    );
    const validity = tlv(0x30, tlv(0x17, Buffer.from('260101000000Z')), tlv(0x17, Buffer.from('360101000000Z')));
    const tbs = tlv(
        0x30,
        tlv(0xa0, tlv(0x02, Buffer.from([2]))),
        tlv(0x02, Buffer.concat([Buffer.from([1]), randomBytes(15)])),
        ecdsaWithSha256,
        name,
        validity,
        name,
        publicKey.export({ format: 'der', type: 'spki' }),
    );
    const signature = tlv(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey));
    return {
        der: tlv(0x30, tbs, ecdsaWithSha256, signature),
        keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    };
}

async function formsFoundIn(content: Uint8Array, needles: readonly SecretNeedle[]): Promise<readonly string[]> {
    const tar = tarArchive([
        { name: 'etc/', typeflag: '5' },
        { name: 'etc/unrelated', content: randomBytes(4096) },
        { name: 'data/file', content },
    ]);
    const report = await scanTarStream('relay', chunked(tar, 1000), needles);
    for (const finding of report.findings) expect(finding.label).toBe('relay:data/file');
    return report.findings.map((finding) => finding.form);
}

/** Each needle on its own, surrounded by noise, so every form is proven to be found by itself. */
async function expectEveryFormFound(needles: readonly SecretNeedle[]): Promise<void> {
    for (const needle of needles) {
        const content = Buffer.concat([randomBytes(333), needle.bytes, randomBytes(333)]);
        expect(await formsFoundIn(content, needles)).toContain(needle.form);
    }
    expect(await formsFoundIn(randomBytes(64 * 1024), needles)).toEqual([]);
}

function base64(value: string): Buffer {
    return Buffer.from(value, 'base64url');
}

describe('ed25519PrivateKeyForms', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const forms = ed25519PrivateKeyForms('engine identity key', pem);
    const seed = base64(privateKey.export({ format: 'jwk' }).d ?? '');

    it('covers the PEM file, PKCS#8 DER and the seed in every common encoding', () => {
        expect(forms.map((form) => [form.secret, form.form])).toEqual(
            [
                'PEM',
                'PKCS#8 DER',
                'PKCS#8 DER, base64',
                'PKCS#8 PEM, first line',
                'seed',
                'seed, base64url (JWK d)',
                'seed, base64',
                'seed, hex',
            ].map((form) => ['engine identity key', form]),
        );
        const bytes = new Map(forms.map((form) => [form.form, Buffer.from(form.bytes).toString('latin1')]));
        expect(bytes.get('PEM')).toBe(pem.trim());
        expect(bytes.get('seed')).toBe(seed.toString('latin1'));
        expect(bytes.get('seed, base64url (JWK d)')).toBe(seed.toString('base64url'));
        expect(bytes.get('seed, hex')).toBe(seed.toString('hex'));
    });

    it('finds every form inside a file of a tar, and nothing in a tar without the key', async () => {
        await expectEveryFormFound(forms);
    });

    it('finds the key file as it sits on disk and as an escaped JSON string', async () => {
        expect(await formsFoundIn(Buffer.from(pem), forms)).toContain('PEM');
        expect(await formsFoundIn(Buffer.from(JSON.stringify({ key: pem })), forms)).toContain('PKCS#8 DER, base64');
    });

    it('refuses a key of another type without echoing it', () => {
        const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
            format: 'pem',
            type: 'pkcs8',
        });
        expect(() => ed25519PrivateKeyForms('engine identity key', ec.toString())).toThrow(
            'engine identity key: expected a ed25519 key',
        );
        expect(() => ed25519PrivateKeyForms('engine identity key', 'not a key')).toThrow(
            /^engine identity key: not a PEM private key$/,
        );
    });
});

describe('ecPrivateKeyForms', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const forms = ecPrivateKeyForms('dev CA key', pem);

    it('covers the PEM file, PKCS#8 and SEC1 DER and the scalar in every common encoding', () => {
        expect(forms.map((form) => form.form)).toEqual([
            'PEM',
            'PKCS#8 DER',
            'PKCS#8 DER, base64',
            'PKCS#8 PEM, first line',
            'SEC1 DER',
            'SEC1 DER, base64',
            'SEC1 PEM, first line',
            'scalar',
            'scalar, base64url (JWK d)',
            'scalar, base64',
            'scalar, hex',
        ]);
    });

    it('finds every form inside a file of a tar, and nothing in a tar without the key', async () => {
        await expectEveryFormFound(forms);
    });

    it('finds the SEC1 rendering of the same key', async () => {
        const sec1 = privateKey.export({ format: 'pem', type: 'sec1' }).toString();
        expect(await formsFoundIn(Buffer.from(sec1), forms)).toEqual(['SEC1 PEM, first line']);
    });
});

describe('certificateForms', () => {
    const certificate = selfSignedCertificate();
    const forms = certificateForms('engine TLS leaf', certificate.der);

    it('covers the certificate and its public key', () => {
        expect(forms.map((form) => form.form)).toEqual([
            'certificate DER',
            'certificate DER, base64',
            'certificate PEM, first line',
            'public key, SPKI DER',
            'public key, raw',
        ]);
    });

    it('finds every form inside a file of a tar, and nothing in a tar without the certificate', async () => {
        await expectEveryFormFound(forms);
    });

    it('finds the PEM certificate and a DER copy of its private key', async () => {
        expect(await formsFoundIn(Buffer.from(new X509Certificate(certificate.der).toString()), forms)).toEqual([
            'certificate PEM, first line',
        ]);
        const keyDer = Buffer.from(certificate.keyPem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64');
        expect(await formsFoundIn(keyDer, forms)).toEqual(['public key, raw']);
    });
});

describe('secretNeedle', () => {
    it('refuses needles short enough to match by chance, without echoing them', () => {
        const short = Buffer.from('0123456789abcde');
        expect(short.length).toBe(MIN_NEEDLE_BYTES - 1);
        expect(() => secretNeedle('token', 'raw', short)).toThrow(RangeError);
        expect(() => secretNeedle('token', 'raw', short)).not.toThrow(short.toString());
        expect(secretNeedle('token', 'raw', Buffer.concat([short, short])).form).toBe('raw');
    });
});
