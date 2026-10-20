import { X509Certificate, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    KEY_USAGE,
    OID,
    authorityKeyIdentifier,
    basicConstraints,
    certificateExtensions,
    extendedKeyUsage,
    extension,
    keyUsage,
    signCertificate,
    subjectAltName,
    subjectKeyIdentifier,
    toPem,
} from './certificate';
import { TAG, childrenOf, decodeOid, explicit, octetString, oid, readDer, sequence, smallInteger } from './der';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

function keys() {
    return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function selfSigned(extensions: readonly Buffer[]) {
    const pair = keys();
    const pem = signCertificate({
        subject: 'Test',
        issuer: 'Test',
        notBefore: new Date(NOW),
        notAfter: new Date(NOW + 86_400_000),
        publicKey: pair.publicKey,
        issuerKey: pair.privateKey,
        extensions,
    });
    return { pair, pem, certificate: new X509Certificate(pem) };
}

describe('signCertificate', () => {
    it('produces certificates OpenSSL parses and verifies, with minimal random serials', () => {
        // Each serial is 16 random bytes; a non-minimal INTEGER would make roughly 1 in 512 of them unparseable.
        for (let index = 0; index < 64; index++) {
            const { pair, certificate } = selfSigned([basicConstraints({ ca: true, pathLen: 0 })]);
            expect(certificate.verify(pair.publicKey)).toBe(true);
            expect(certificate.subject).toBe('CN=Test');
            expect(certificate.ca).toBe(true);
            expect(certificate.validFromDate.getTime()).toBe(NOW);
            const [tbs] = childrenOf(readDer(certificate.raw));
            const serial = tbs === undefined ? undefined : childrenOf(tbs)[1];
            expect(serial?.tag).toBe(TAG.integer);
            const [first = 0, second = 0] = serial?.content ?? [];
            expect(first & 0x80).toBe(0);
            expect(first === 0 && (second & 0x80) === 0).toBe(false);
        }
    });

    it('writes SANs, key usage, EKU and key identifiers that link a leaf to its issuer', () => {
        const issuer = keys();
        const caCert = new X509Certificate(
            signCertificate({
                subject: 'Issuer',
                issuer: 'Issuer',
                notBefore: new Date(NOW),
                notAfter: new Date(NOW + 86_400_000),
                publicKey: issuer.publicKey,
                issuerKey: issuer.privateKey,
                extensions: [
                    basicConstraints({ ca: true, pathLen: 0 }),
                    keyUsage(KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign),
                    subjectKeyIdentifier(issuer.publicKey),
                ],
            }),
        );
        const leaf = new X509Certificate(
            signCertificate({
                subject: 'a.engine.test',
                issuer: 'Issuer',
                notBefore: new Date(NOW),
                notAfter: new Date(NOW + 86_400_000),
                publicKey: keys().publicKey,
                issuerKey: issuer.privateKey,
                extensions: [
                    basicConstraints({ ca: false }),
                    keyUsage(KEY_USAGE.digitalSignature),
                    extendedKeyUsage(OID.serverAuth),
                    subjectAltName(['a.engine.test', '127.0.0.1']),
                    authorityKeyIdentifier(issuer.publicKey),
                ],
            }),
        );
        expect(leaf.checkIssued(caCert)).toBe(true);
        expect(leaf.verify(caCert.publicKey)).toBe(true);
        expect(leaf.subjectAltName).toBe('DNS:a.engine.test, IP Address:127.0.0.1');
        expect(leaf.keyUsage).toEqual([OID.serverAuth]);

        const caExtensions = certificateExtensions(caCert.raw);
        const leafExtensions = certificateExtensions(leaf.raw);
        const ski = caExtensions.get(OID.subjectKeyIdentifier)?.value.content;
        const aki = childrenOf(leafExtensions.get(OID.authorityKeyIdentifier)?.value ?? readDer(sequence()))[0];
        expect(ski?.length).toBe(20);
        expect(aki?.tag).toBe(0x80);
        expect(aki?.content.equals(ski ?? Buffer.alloc(0))).toBe(true);
        expect(leafExtensions.get(OID.basicConstraints)).toMatchObject({ critical: true });
        expect(leafExtensions.get(OID.keyUsage)?.value.content.toString('hex')).toBe('0780');
        expect(leafExtensions.get(OID.extKeyUsage)?.critical).toBe(false);
        expect(caExtensions.get(OID.keyUsage)?.value.content.toString('hex')).toBe('0106');
    });
});

describe('certificateExtensions', () => {
    it('is empty for a certificate without extensions', () => {
        const tbs = sequence(smallInteger(1));
        expect(certificateExtensions(sequence(tbs)).size).toBe(0);
    });

    it('decodes an extension OID and reads criticality only from an explicit TRUE', () => {
        const tbs = sequence(
            smallInteger(1),
            explicit(3, sequence(extension('1.2.3.4', false, sequence()), extension('1.2.3.5', true, sequence()))),
        );
        const extensions = certificateExtensions(sequence(tbs));
        expect([...extensions.entries()].map(([id, value]) => [id, value.critical])).toEqual([
            ['1.2.3.4', false],
            ['1.2.3.5', true],
        ]);
        expect(decodeOid(readDer(oid('1.2.3.4')))).toBe('1.2.3.4');
    });

    it('throws on an empty certificate and a malformed extension', () => {
        expect(() => certificateExtensions(sequence())).toThrow('empty certificate');
        const withExtension = (item: Buffer) => sequence(sequence(explicit(3, sequence(item))));
        expect(() => certificateExtensions(withExtension(sequence(oid('1.2.3.4'), smallInteger(1))))).toThrow(
            'malformed extension',
        );
        expect(() => certificateExtensions(withExtension(sequence()))).toThrow('malformed extension');
        expect(() =>
            certificateExtensions(withExtension(sequence(smallInteger(1), octetString(sequence())))),
        ).toThrow();
    });
});

describe('toPem', () => {
    it('wraps base64 at 64 characters', () => {
        const pem = toPem('CERTIFICATE', Buffer.alloc(100, 1));
        const lines = pem.trimEnd().split('\n');
        expect(lines[0]).toBe('-----BEGIN CERTIFICATE-----');
        expect(lines.at(-1)).toBe('-----END CERTIFICATE-----');
        expect(lines.slice(1, -1).map((line) => line.length)).toEqual([64, 64, 8]);
    });
});
