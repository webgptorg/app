import { X509Certificate, generateKeyPairSync, sign } from 'node:crypto';
import { isIP } from 'node:net';

/** A self-signed certificate and its key, both PEM, generated per test run: no key material is checked in. */
export interface TestCertificate {
    readonly cert: string;
    readonly key: string;
}

function length(size: number): number[] {
    if (size < 0x80) return [size];
    const bytes: number[] = [];
    for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
    return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, ...contents: readonly Uint8Array[]): Uint8Array {
    const body = Buffer.concat(contents);
    return Buffer.concat([Uint8Array.of(tag, ...length(body.length)), body]);
}

const sequence = (...contents: readonly Uint8Array[]): Uint8Array => der(0x30, ...contents);

function oid(dotted: string): Uint8Array {
    const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
    const bytes = [first * 40 + second];
    for (const arc of rest) {
        const encoded = [arc & 0x7f];
        for (let value = arc >>> 7; value > 0; value >>>= 7) encoded.unshift(0x80 | (value & 0x7f));
        bytes.push(...encoded);
    }
    return der(0x06, Uint8Array.from(bytes));
}

function utcTime(date: Date): Uint8Array {
    const iso = date.toISOString();
    const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
    return der(0x17, Buffer.from(text, 'ascii'));
}

function ipBytes(ip: string): Uint8Array {
    if (isIP(ip) === 4) return Uint8Array.from(ip.split('.').map(Number));
    // Only the loopback address is needed in tests.
    return Uint8Array.of(...new Array<number>(15).fill(0), 1);
}

const SIGNATURE_ALGORITHMS = {
    rsa: sequence(oid('1.2.840.113549.1.1.11'), Uint8Array.of(0x05, 0x00)),
    ec: sequence(oid('1.2.840.10045.4.3.2')),
} as const;

/**
 * Self-signed for `names` (DNS names and IP addresses in the SAN), valid from an hour ago for a day. `rsa` lets TLS
 * tests offer non-ECDHE suites (static RSA, DHE-RSA) that an ECDSA key could not use anyway.
 */
export function createTestCertificate(names: readonly string[], keyType: 'rsa' | 'ec' = 'ec'): TestCertificate {
    const { publicKey, privateKey } =
        keyType === 'rsa'
            ? generateKeyPairSync('rsa', { modulusLength: 2048 })
            : generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const algorithm = SIGNATURE_ALGORITHMS[keyType];
    const [first = 'relay.test'] = names;
    const name = sequence(der(0x31, sequence(oid('2.5.4.3'), der(0x0c, Buffer.from(first, 'utf8')))));
    const san = sequence(
        ...names.map((entry) =>
            isIP(entry) === 0 ? der(0x82, Buffer.from(entry, 'ascii')) : der(0x87, ipBytes(entry)),
        ),
    );
    const now = Date.now();
    const tbs = sequence(
        der(0xa0, der(0x02, Uint8Array.of(2))),
        der(0x02, Uint8Array.of(0x01, ...Array.from({ length: 7 }, (_, index) => (now >> index) & 0xff))),
        algorithm,
        name,
        sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
        name,
        publicKey.export({ type: 'spki', format: 'der' }),
        der(0xa3, sequence(sequence(oid('2.5.29.17'), der(0x04, san)))),
    );
    const signature = sign('sha256', tbs, privateKey);
    const certificate = sequence(tbs, algorithm, der(0x03, Uint8Array.of(0), signature));
    return {
        cert: new X509Certificate(certificate).toString(),
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
}
