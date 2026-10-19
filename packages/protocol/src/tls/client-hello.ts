import { createByteReader } from './byte-reader';
import type { ByteReader } from './byte-reader';

export type MalformedReason =
    | 'not-handshake'
    | 'unsupported-record-version'
    | 'not-client-hello'
    | 'length-mismatch'
    | 'bad-extensions'
    | 'duplicate-extension'
    | 'bad-server-name';

export type ClientHelloParse =
    | { readonly kind: 'need-more' }
    | { readonly kind: 'sni'; readonly hostname: string; readonly alpn: readonly string[] }
    | { readonly kind: 'no-sni'; readonly alpn: readonly string[] }
    | { readonly kind: 'malformed'; readonly reason: MalformedReason }
    | { readonly kind: 'too-large' };

export interface ClientHelloLimits {
    /** Most bytes, record headers included, the ClientHello may span before parsing gives up. */
    readonly maxBytes: number;
}

const RECORD_HEADER_BYTES = 5;
const HANDSHAKE_HEADER_BYTES = 4;
const MAX_RECORD_PAYLOAD_BYTES = 2 ** 14;
const CONTENT_TYPE_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const RANDOM_BYTES = 32;
const MAX_SESSION_ID_BYTES = 32;
const EXTENSION_SERVER_NAME = 0;
const EXTENSION_ALPN = 16;
const NAME_TYPE_HOST_NAME = 0;
const MAX_HOSTNAME_BYTES = 253;

export const NEED_MORE: ClientHelloParse = Object.freeze({ kind: 'need-more' });
const TOO_LARGE: ClientHelloParse = Object.freeze({ kind: 'too-large' });

function malformed(reason: MalformedReason): ClientHelloParse {
    return { kind: 'malformed', reason };
}

export function assertLimits(limits: ClientHelloLimits): void {
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
        throw new RangeError('maxBytes must be a positive integer');
    }
}

/**
 * Reads the hostname (SNI) and offered ALPN protocols from the first bytes of a TLS connection.
 *
 * Total over untrusted input: never throws, never reads past `bytes`, and only looks at the first
 * `maxBytes`. Every check runs in byte order on bytes already present, so a malformed or too-large
 * verdict on a prefix is also the verdict on any longer input; `need-more` means only that.
 */
export function parseClientHello(bytes: Uint8Array, limits: ClientHelloLimits): ClientHelloParse {
    assertLimits(limits);
    const { maxBytes } = limits;
    const available = Math.min(bytes.byteLength, maxBytes);
    const incomplete = available === maxBytes ? TOO_LARGE : NEED_MORE;
    const view = new DataView(bytes.buffer, bytes.byteOffset, available);
    // A ClientHello may be fragmented over several records, so its bytes are reassembled here.
    const handshake = new Uint8Array(available);
    let handshakeFilled = 0;
    let handshakeEnd: number | undefined;
    let offset = 0;

    for (;;) {
        const headerProblem = recordHeaderProblem(view, offset);
        if (headerProblem !== undefined) return malformed(headerProblem);
        if (offset + RECORD_HEADER_BYTES > available) return incomplete;

        const payloadLength = view.getUint16(offset + 3);
        if (payloadLength === 0 || payloadLength > MAX_RECORD_PAYLOAD_BYTES) return malformed('length-mismatch');
        const payloadStart = offset + RECORD_HEADER_BYTES;
        const recordEnd = payloadStart + payloadLength;
        if (recordEnd > maxBytes) return TOO_LARGE;

        const handshakeBeforeRecord = handshakeFilled;
        const copyEnd = Math.min(recordEnd, available);
        handshake.set(bytes.subarray(payloadStart, copyEnd), handshakeFilled);
        handshakeFilled += copyEnd - payloadStart;

        if (handshakeFilled >= 1 && handshake[0] !== HANDSHAKE_CLIENT_HELLO) return malformed('not-client-hello');
        if (handshakeEnd === undefined && handshakeFilled >= HANDSHAKE_HEADER_BYTES) {
            handshakeEnd = HANDSHAKE_HEADER_BYTES + readUint24(handshake, 1);
        }
        if (handshakeEnd !== undefined) {
            const handshakeAfterRecord = handshakeBeforeRecord + payloadLength;
            // Clients send nothing after the ClientHello until the server answers, and a TLS 1.3 key
            // change (0-RTT) must fall on a record boundary, so a ClientHello sharing a record is invalid.
            if (handshakeAfterRecord > handshakeEnd) return malformed('length-mismatch');
            if (smallestEnd(recordEnd, handshakeEnd - handshakeAfterRecord) > maxBytes) return TOO_LARGE;
        }

        if (copyEnd < recordEnd) return incomplete;
        if (handshakeFilled === handshakeEnd) {
            return parseClientHelloBody(handshake.subarray(HANDSHAKE_HEADER_BYTES, handshakeEnd));
        }
        offset = recordEnd;
    }
}

/** Checks whichever of a record header's type and version bytes are already present. */
function recordHeaderProblem(view: DataView, offset: number): MalformedReason | undefined {
    const present = view.byteLength - offset;
    // SSLv2-style hellos (high bit set) and plaintext protocols fail here too.
    if (present >= 1 && view.getUint8(offset) !== CONTENT_TYPE_HANDSHAKE) return 'not-handshake';
    if (present >= 2 && view.getUint8(offset + 1) !== 0x03) return 'unsupported-record-version';
    if (present >= 3) {
        const minor = view.getUint8(offset + 2);
        if (minor < 0x01 || minor > 0x03) return 'unsupported-record-version';
    }
    return undefined;
}

/** The earliest offset at which `remaining` more handshake bytes can end, given full-size records. */
function smallestEnd(recordEnd: number, remaining: number): number {
    return recordEnd + remaining + RECORD_HEADER_BYTES * Math.ceil(remaining / MAX_RECORD_PAYLOAD_BYTES);
}

function readUint24(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0);
}

function parseClientHelloBody(body: Uint8Array): ClientHelloParse {
    const reader = createByteReader(body);
    const legacyVersionAndRandom = reader.bytes(2 + RANDOM_BYTES);
    const sessionIdLength = reader.u8();
    if (legacyVersionAndRandom === undefined || sessionIdLength === undefined) return malformed('length-mismatch');
    if (sessionIdLength > MAX_SESSION_ID_BYTES || reader.bytes(sessionIdLength) === undefined) {
        return malformed('length-mismatch');
    }
    const cipherSuitesLength = reader.u16();
    if (
        cipherSuitesLength === undefined ||
        cipherSuitesLength < 2 ||
        cipherSuitesLength % 2 !== 0 ||
        reader.bytes(cipherSuitesLength) === undefined
    ) {
        return malformed('length-mismatch');
    }
    const compressionMethodsLength = reader.u8();
    if (
        compressionMethodsLength === undefined ||
        compressionMethodsLength < 1 ||
        reader.bytes(compressionMethodsLength) === undefined
    ) {
        return malformed('length-mismatch');
    }
    // Extensions are optional before TLS 1.3; a hello without them has no SNI.
    if (reader.remaining === 0) return { kind: 'no-sni', alpn: [] };
    const extensionsLength = reader.u16();
    if (extensionsLength === undefined || extensionsLength !== reader.remaining) return malformed('bad-extensions');
    return parseExtensions(reader);
}

function parseExtensions(reader: ByteReader): ClientHelloParse {
    const seen = new Set<number>();
    let hostname: string | undefined;
    let alpn: readonly string[] = [];
    while (reader.remaining > 0) {
        const type = reader.u16();
        const length = reader.u16();
        const data = length === undefined ? undefined : reader.bytes(length);
        if (type === undefined || data === undefined) return malformed('bad-extensions');
        if (seen.has(type)) return malformed('duplicate-extension');
        seen.add(type);
        if (type === EXTENSION_SERVER_NAME) {
            hostname = parseServerName(data);
            if (hostname === undefined) return malformed('bad-server-name');
        } else if (type === EXTENSION_ALPN) {
            const protocols = parseAlpn(data);
            if (protocols === undefined) return malformed('bad-extensions');
            alpn = protocols;
        }
    }
    return hostname === undefined ? { kind: 'no-sni', alpn } : { kind: 'sni', hostname, alpn };
}

/** Accepts exactly one `host_name` entry holding a dotted LDH name; returns it lowercased. */
function parseServerName(data: Uint8Array): string | undefined {
    const reader = createByteReader(data);
    const listLength = reader.u16();
    if (listLength !== reader.remaining) return undefined;
    const nameType = reader.u8();
    const nameLength = reader.u16();
    const name = nameLength === undefined ? undefined : reader.bytes(nameLength);
    if (nameType !== NAME_TYPE_HOST_NAME || name === undefined || reader.remaining !== 0) return undefined;
    return normalizeHostname(name);
}

const DOT = 0x2e;

function normalizeHostname(name: Uint8Array): string | undefined {
    if (name.length < 1 || name.length > MAX_HOSTNAME_BYTES) return undefined;
    const codes: number[] = [];
    let previous = DOT;
    for (const byte of name) {
        const isUpper = byte >= 0x41 && byte <= 0x5a;
        const isLower = byte >= 0x61 && byte <= 0x7a;
        const isDigit = byte >= 0x30 && byte <= 0x39;
        if (!isUpper && !isLower && !isDigit && byte !== 0x2d && byte !== DOT) return undefined;
        if (byte === DOT && previous === DOT) return undefined;
        codes.push(isUpper ? byte | 0x20 : byte);
        previous = byte;
    }
    if (previous === DOT) return undefined;
    return String.fromCharCode(...codes);
}

/**
 * ALPN names are opaque bytes; mapping each byte to one code unit (Latin-1) keeps any value intact
 * while registered names such as `acme-tls/1` read as themselves.
 */
function parseAlpn(data: Uint8Array): readonly string[] | undefined {
    const reader = createByteReader(data);
    const listLength = reader.u16();
    if (listLength === undefined || listLength < 2 || listLength !== reader.remaining) return undefined;
    const protocols: string[] = [];
    while (reader.remaining > 0) {
        const length = reader.u8();
        const name = length === undefined || length === 0 ? undefined : reader.bytes(length);
        if (name === undefined) return undefined;
        protocols.push(String.fromCharCode(...name));
    }
    return protocols;
}
