// Builds TLS records byte by byte for tests, so each case states exactly which field is wrong.

export const EXTENSION_SERVER_NAME = 0;
export const EXTENSION_PADDING = 21;
export const EXTENSION_ALPN = 16;

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

export function latin1(text: string): Uint8Array {
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

export function u8(value: number): Uint8Array {
    return Uint8Array.of(value);
}

export function u16(value: number): Uint8Array {
    return Uint8Array.of(value >> 8, value & 0xff);
}

export function u24(value: number): Uint8Array {
    return Uint8Array.of(value >> 16, (value >> 8) & 0xff, value & 0xff);
}

export function withU8Length(data: Uint8Array): Uint8Array {
    return concat(u8(data.length), data);
}

export function withU16Length(data: Uint8Array): Uint8Array {
    return concat(u16(data.length), data);
}

export function extension(type: number, data: Uint8Array): Uint8Array {
    return concat(u16(type), withU16Length(data));
}

/** A `server_name` extension with one `host_name` entry per name. */
export function serverNameExtension(...names: readonly (string | Uint8Array)[]): Uint8Array {
    const entries = names.map((name) => concat(u8(0), withU16Length(typeof name === 'string' ? latin1(name) : name)));
    return extension(EXTENSION_SERVER_NAME, withU16Length(concat(...entries)));
}

export function alpnExtension(...protocols: readonly string[]): Uint8Array {
    return extension(EXTENSION_ALPN, withU16Length(concat(...protocols.map((name) => withU8Length(latin1(name))))));
}

export function paddingExtension(length: number): Uint8Array {
    return extension(EXTENSION_PADDING, new Uint8Array(length));
}

/** A TLS 1.2-style body (legacy version, random, session ID, suites, compression), then extensions. */
export function clientHelloBody(extensions: readonly Uint8Array[] | undefined): Uint8Array {
    const fixedFields = concat(
        u16(0x0303),
        new Uint8Array(32).fill(0xab),
        withU8Length(new Uint8Array(32).fill(0xcd)),
        withU16Length(Uint8Array.of(0x13, 0x01, 0x13, 0x02)),
        withU8Length(u8(0)),
    );
    return extensions === undefined ? fixedFields : concat(fixedFields, withU16Length(concat(...extensions)));
}

export function handshakeMessage(type: number, body: Uint8Array): Uint8Array {
    return concat(u8(type), u24(body.length), body);
}

export function record(payload: Uint8Array, contentType = 0x16, version = 0x0301): Uint8Array {
    return concat(u8(contentType), u16(version), withU16Length(payload));
}

const MAX_RECORD_PAYLOAD_BYTES = 2 ** 14;

/**
 * Splits a handshake stream into records: one per given payload size, then the rest in as few
 * records as the 2^14-byte limit allows.
 */
export function records(handshake: Uint8Array, fragmentSizes: readonly number[] = []): Uint8Array {
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (const size of fragmentSizes) {
        if (offset + size >= handshake.length) break;
        parts.push(record(handshake.subarray(offset, offset + size)));
        offset += size;
    }
    do {
        const end = Math.min(offset + MAX_RECORD_PAYLOAD_BYTES, handshake.length);
        parts.push(record(handshake.subarray(offset, end)));
        offset = end;
    } while (offset < handshake.length);
    return concat(...parts);
}

export function clientHello(
    extensions: readonly Uint8Array[] | undefined,
    fragmentSizes?: readonly number[],
): Uint8Array {
    return records(handshakeMessage(1, clientHelloBody(extensions)), fragmentSizes);
}
