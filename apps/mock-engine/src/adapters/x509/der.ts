/*
 * A minimal DER writer and reader, just enough for the dev CA's certificates. Hand-rolled because the ASN.1 libraries
 * break whenever a second copy of @peculiar/asn1-schema lands in the tree (its schema registry is per copy), and
 * @peculiar/x509 needs a global reflect-metadata polyfill that is not in the catalog. OpenSSL verifies everything this
 * writes (the tests connect through `node:tls`), so an encoding mistake fails loudly instead of silently.
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

const MAX_LENGTH_OCTETS = 4;

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
export const bitString = (content: Uint8Array, unusedBits = 0): Buffer =>
    tlv(TAG.bitString, Buffer.of(unusedBits), content);
export const boolean = (value: boolean): Buffer => tlv(TAG.boolean, Buffer.of(value ? 0xff : 0));
export const utf8String = (text: string): Buffer => tlv(TAG.utf8String, Buffer.from(text, 'utf8'));
export const explicit = (tagNumber: number, content: Uint8Array): Buffer =>
    tlv(constructedContextTag(tagNumber), content);

/** A non-negative INTEGER from big-endian magnitude bytes. */
export function unsignedInteger(bytes: Uint8Array): Buffer {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const magnitude = bytes.length === 0 ? Buffer.of(0) : Buffer.from(bytes.subarray(start));
    // A set high bit would make the DER INTEGER negative.
    return tlv(TAG.integer, (magnitude[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.of(0), magnitude]) : magnitude);
}

export const smallInteger = (value: number): Buffer => unsignedInteger(Buffer.of(value));

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

/** One decoded TLV: `content` is the value octets, `encoded` the whole element. */
export interface DerNode {
    readonly tag: number;
    readonly content: Buffer;
    readonly encoded: Buffer;
}

export class DerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DerError';
    }
}

function readNode(bytes: Buffer, offset: number): DerNode {
    const tag = bytes[offset];
    const first = bytes[offset + 1];
    if (tag === undefined || first === undefined) throw new DerError('truncated element');
    if ((tag & 0x1f) === 0x1f) throw new DerError('multi-byte tags are not used in X.509');
    let length = first;
    let header = 2;
    if (first & 0x80) {
        const octets = first & 0x7f;
        if (octets === 0 || octets > MAX_LENGTH_OCTETS) throw new DerError('unsupported length form');
        length = 0;
        for (let i = 0; i < octets; i++) {
            const octet = bytes[offset + 2 + i];
            if (octet === undefined) throw new DerError('truncated length');
            length = length * 256 + octet;
        }
        if (length < 0x80 || bytes[offset + 2] === 0) throw new DerError('non-minimal length');
        header += octets;
    }
    const end = offset + header + length;
    if (end > bytes.length) throw new DerError('element runs past the input');
    return { tag, content: bytes.subarray(offset + header, end), encoded: bytes.subarray(offset, end) };
}

/** Decodes exactly one element; trailing bytes are an error. */
export function readDer(bytes: Uint8Array): DerNode {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const node = readNode(buffer, 0);
    if (node.encoded.length !== buffer.length) throw new DerError('trailing bytes after the element');
    return node;
}

/** The elements inside a constructed node (SEQUENCE, SET, `[n]` constructed). */
export function childrenOf(node: DerNode): readonly DerNode[] {
    if ((node.tag & 0x20) === 0) throw new DerError('not a constructed element');
    const children: DerNode[] = [];
    for (let offset = 0; offset < node.content.length;) {
        const child = readNode(node.content, offset);
        children.push(child);
        offset += child.encoded.length;
    }
    return children;
}

export function decodeOid(node: DerNode): string {
    if (node.tag !== TAG.oid || node.content.length === 0) throw new DerError('not an OBJECT IDENTIFIER');
    const [head = 0] = node.content;
    const arcs = [Math.min(Math.floor(head / 40), 2), head - Math.min(Math.floor(head / 40), 2) * 40];
    let value = 0;
    for (const byte of node.content.subarray(1)) {
        value = value * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0) {
            arcs.push(value);
            value = 0;
        }
    }
    return arcs.join('.');
}
