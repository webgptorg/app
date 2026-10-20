import type { KeyObject } from 'node:crypto';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/*
 * A minimal DER writer, just enough for test certificates. Hand-rolled because the catalog's ASN.1 libraries resolve
 * to two copies of @peculiar/asn1-schema whose schema registries do not see each other.
 */

const HOUR_MS = 3_600_000;
const OID = {
    ecdsaWithSha256: '1.2.840.10045.4.3.2',
    commonName: '2.5.4.3',
    basicConstraints: '2.5.29.19',
    keyUsage: '2.5.29.15',
    extKeyUsage: '2.5.29.37',
    subjectAltName: '2.5.29.17',
    serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;

function length(n: number): Buffer {
    if (n < 0x80) return Buffer.of(n);
    const bytes: number[] = [];
    for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: readonly Buffer[]): Buffer {
    const body = Buffer.concat(content);
    return Buffer.concat([Buffer.of(tag), length(body.length), body]);
}

const sequence = (...items: readonly Buffer[]): Buffer => tlv(0x30, ...items);
const set = (...items: readonly Buffer[]): Buffer => tlv(0x31, ...items);
const octetString = (content: Buffer): Buffer => tlv(0x04, content);
const bitString = (content: Buffer, unusedBits = 0): Buffer => tlv(0x03, Buffer.of(unusedBits), content);
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.of(value ? 0xff : 0));
const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const explicit = (tagNumber: number, content: Buffer): Buffer => tlv(0xa0 | tagNumber, content);

function integer(bytes: Buffer): Buffer {
    // A set high bit would make the DER INTEGER negative.
    return tlv(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.of(0), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
    const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
    const bytes = [first * 40 + second];
    for (const arc of rest) {
        const groups = [arc & 0x7f];
        for (let value = arc >>> 7; value > 0; value >>>= 7) groups.unshift(0x80 | (value & 0x7f));
        bytes.push(...groups);
    }
    return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
    const text = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
    return tlv(0x17, Buffer.from(`${text}Z`, 'ascii'));
}

function name(commonName: string): Buffer {
    return sequence(set(sequence(oid(OID.commonName), utf8String(commonName))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
    return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

/** `KeyUsage` bits, numbered from the most significant bit of the first byte (RFC 5280). */
function keyUsage(...bits: readonly number[]): Buffer {
    const value = bits.reduce((byte, bit) => byte | (0x80 >> bit), 0);
    const unused = Math.min(...bits.map((bit) => 7 - bit));
    return bitString(Buffer.of(value), unused);
}

const KEY_USAGE = { digitalSignature: 0, keyCertSign: 5, cRLSign: 6 } as const;

function signCertificate(
    subject: string,
    issuer: string,
    publicKey: KeyObject,
    issuerKey: KeyObject,
    extensions: readonly Buffer[],
): string {
    const algorithm = sequence(oid(OID.ecdsaWithSha256));
    const now = Date.now();
    const tbs = sequence(
        explicit(0, integer(Buffer.of(2))),
        integer(randomBytes(16)),
        algorithm,
        name(issuer),
        sequence(utcTime(new Date(now - HOUR_MS)), utcTime(new Date(now + 24 * HOUR_MS))),
        name(subject),
        publicKey.export({ type: 'spki', format: 'der' }),
        explicit(3, sequence(...extensions)),
    );
    const certificate = sequence(tbs, algorithm, bitString(sign('sha256', tbs, issuerKey)));
    const base64 = certificate.toString('base64');
    return `-----BEGIN CERTIFICATE-----\n${(base64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;
}

export interface TestCertificate {
    readonly certPem: string;
    readonly keyPem: string;
}

export interface TestCa {
    readonly certPem: string;
    /** A server certificate for `hostnames` (subjectAltName dNSName), signed by this CA. */
    issue(hostnames: readonly string[]): TestCertificate;
}

/** A throwaway ECDSA P-256 CA generated at test time, so no key material is checked in. */
export function createTestCa(commonName: string): TestCa {
    const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const certPem = signCertificate(commonName, commonName, ca.publicKey, ca.privateKey, [
        extension(OID.basicConstraints, true, sequence(boolean(true))),
        extension(OID.keyUsage, true, keyUsage(KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign)),
    ]);
    return {
        certPem,
        issue(hostnames) {
            const leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
            const dnsNames = hostnames.map((hostname) => tlv(0x82, Buffer.from(hostname, 'ascii')));
            const leafPem = signCertificate(hostnames[0] ?? 'leaf', commonName, leaf.publicKey, ca.privateKey, [
                extension(OID.basicConstraints, true, sequence()),
                extension(OID.keyUsage, true, keyUsage(KEY_USAGE.digitalSignature)),
                extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
                extension(OID.subjectAltName, false, sequence(...dnsNames)),
            ]);
            return { certPem: leafPem, keyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
        },
    };
}
