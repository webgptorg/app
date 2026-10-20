import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';

import { describe, expect, it } from 'vitest';

import { createSeededRandom } from './seeded-random';
import { createTestCa, integer } from './test-pki';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** The content octets of a short-form DER INTEGER, checked for tag and length. */
function content(der: Buffer): Buffer {
    expect(der[0]).toBe(0x02);
    expect(der[1]).toBe(der.length - 2);
    return der.subarray(2);
}

/** X.690 8.3.2: the first nine bits are never all zeros or all ones. */
function isMinimal(octets: Buffer): boolean {
    if (octets.length === 0) return false;
    if (octets.length === 1) return true;
    const [first = 0, second = 0] = octets;
    return !(first === 0x00 && (second & 0x80) === 0) && !(first === 0xff && (second & 0x80) !== 0);
}

function unsigned(bytes: Uint8Array): bigint {
    return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

describe('integer (DER)', () => {
    it.each([
        ['00 01', '020101'],
        ['00 00 7f', '02017f'],
        ['00 80', '02020080'],
        ['80', '02020080'],
        ['00', '020100'],
        ['7f', '02017f'],
        ['00 00 00 00', '020100'],
        ['01 00', '02020100'],
    ])('encodes %s minimally as %s', (input, expected) => {
        expect(hex(integer(Buffer.from(input.replaceAll(' ', ''), 'hex')))).toBe(expected);
    });

    it('stays minimal and keeps the value for random 1–20 byte inputs, leading zeros included', () => {
        const random = createSeededRandom(512);
        for (let sample = 0; sample < 5000; sample++) {
            const [lengthByte = 0, zerosByte = 0] = random.bytes(2);
            const bytes = Buffer.from(random.bytes(1 + (lengthByte % 20)));
            bytes.fill(0, 0, Math.min(bytes.length, zerosByte % 4));
            const octets = content(integer(bytes));
            expect(isMinimal(octets), hex(bytes)).toBe(true);
            expect((octets[0] ?? 0) & 0x80, 'a serial is never negative').toBe(0);
            expect(unsigned(octets)).toBe(unsigned(bytes));
        }
    });
});

describe('createTestCa', () => {
    it.each([
        ['a leading zero byte', '0001'],
        ['leading zeros before a high bit', '000080'],
        ['a high bit', '80'],
        ['zero', '00'],
    ])('issues certificates OpenSSL accepts for a serial with %s', (_name, serialHex) => {
        const ca = createTestCa('DER test CA', { serial: () => Buffer.from(serialHex, 'hex') });
        const leaf = ca.issue(['relay-a.ptbk.test']);
        for (const pem of [ca.certPem, leaf.certPem]) expect(() => new X509Certificate(pem)).not.toThrow();
        expect(() => createSecureContext({ cert: leaf.certPem, key: leaf.keyPem })).not.toThrow();
        expect(new X509Certificate(leaf.certPem).checkIssued(new X509Certificate(ca.certPem))).toBe(true);
    });
});
