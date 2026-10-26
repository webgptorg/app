/*
 * The few DER encodings an X.509 certificate needs, ported from the mock engine's dev CA (apps/mock-engine, M-02).
 * Hand-rolled rather than a dependency for the same reason: the catalog's ASN.1 libraries need a reflect-metadata
 * polyfill. OpenSSL verifies everything this writes (the tests connect through `node:tls`), so a mistake fails loudly.
 */

export const TAG = {
    boolean: 0x01,
    integer: 0x02,
    bitString: 0x03,
    octetString: 0x04,
    oid: 0x06,
    utf8String: 0x0c,
    utcTime: 0x17,
    generalizedTime: 0x18,
    sequence: 0x30,
    set: 0x31,
} as const;

/** Context-specific tags as they appear in X.509 (implicit tagging): `[n]` primitive and `[n]` constructed. */
export const contextTag = (n: number): number => 0x80 | n;
export const constructedContextTag = (n: number): number => 0xa0 | n;

function encodeLength(n: number): Buffer {
    if (n < 0x80) return Buffer.of(n);
    const bytes: number[] = [];
    for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, ...content: readonly Uint8Array[]): Buffer {
    const body = Buffer.concat(content);
    return Buffer.concat([Buffer.of(tag), encodeLength(body.length), body]);
}

export const sequence = (...items: readonly Uint8Array[]): Buffer => tlv(TAG.sequence, ...items);
export const set = (...items: readonly Uint8Array[]): Buffer => tlv(TAG.set, ...items);
export const octetString = (content: Uint8Array): Buffer => tlv(TAG.octetString, content);
export const bitString = (content: Uint8Array, unusedBits: number): Buffer =>
    tlv(TAG.bitString, Buffer.of(unusedBits), content);
export const boolean = (value: boolean): Buffer => tlv(TAG.boolean, Buffer.of(value ? 0xff : 0));
export const utf8String = (text: string): Buffer => tlv(TAG.utf8String, Buffer.from(text, 'utf8'));
export const explicit = (tagNumber: number, content: Uint8Array): Buffer =>
    tlv(constructedContextTag(tagNumber), content);

/** A non-negative INTEGER from big-endian magnitude bytes. */
export function unsignedInteger(bytes: Uint8Array): Buffer {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const magnitude = Buffer.from(bytes.subarray(start));
    // A set high bit would make the DER INTEGER negative.
    return tlv(TAG.integer, (magnitude[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.of(0), magnitude]) : magnitude);
}

/** The first two arcs must fit one byte (`first * 40 + second < 128`), as they do for every OID used here. */
export function oid(dotted: string): Buffer {
    const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
    const bytes = [first * 40 + second];
    for (const arc of rest) {
        const groups = [arc & 0x7f];
        for (let value = arc >>> 7; value > 0; value >>>= 7) groups.unshift(0x80 | (value & 0x7f));
        bytes.push(...groups);
    }
    return tlv(TAG.oid, Buffer.from(bytes));
}

/** RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050; whole seconds, always `Z`. */
export function time(date: Date): Buffer {
    const text = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return date.getUTCFullYear() < 2050
        ? tlv(TAG.utcTime, Buffer.from(`${text.slice(2)}Z`, 'ascii'))
        : tlv(TAG.generalizedTime, Buffer.from(`${text}Z`, 'ascii'));
}
