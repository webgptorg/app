import { concat } from './pcap-writer.ts';

export const CHANGE_CIPHER_SPEC = 20;
export const ALERT = 21;
export const HANDSHAKE = 22;
export const APPLICATION_DATA = 23;

/** Ciphertext stand-in: a fixed byte pattern that never spells ASCII words, so plaintext searches stay clean. */
export function opaqueBytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, (_, index) => (index * 151 + 0x80) & 0xff);
}

export function tlsRecord(contentType: number, payload: Uint8Array, version = 0x0303): Uint8Array {
    const header = new DataView(new ArrayBuffer(5));
    header.setUint8(0, contentType);
    header.setUint16(1, version);
    header.setUint16(3, payload.byteLength);
    return concat([new Uint8Array(header.buffer), payload]);
}

/** A minimal TLS 1.3-style ClientHello offering one cipher suite and naming `hostname` in its SNI. */
export function clientHello(hostname: string): Uint8Array {
    const name = new TextEncoder().encode(hostname);
    const serverName = concat([u16(name.byteLength + 3), Uint8Array.of(0), u16(name.byteLength), name]);
    const extensions = concat([u16(0), u16(serverName.byteLength), serverName]);
    const body = concat([
        u16(0x0303),
        opaqueBytes(32),
        Uint8Array.of(0),
        u16(2),
        u16(0x1301),
        Uint8Array.of(1, 0),
        u16(extensions.byteLength),
        extensions,
    ]);
    const handshake = concat([Uint8Array.of(1, 0, body.byteLength >> 8, body.byteLength & 0xff), body]);
    return tlsRecord(HANDSHAKE, handshake, 0x0301);
}

/** What a TLS 1.3 client sends: ClientHello, a compatibility change_cipher_spec, then encrypted records. */
export function tls13ClientFlight(hostname: string, applicationRecords: readonly number[]): Uint8Array {
    return concat([
        clientHello(hostname),
        tlsRecord(CHANGE_CIPHER_SPEC, Uint8Array.of(1)),
        ...applicationRecords.map((length) => tlsRecord(APPLICATION_DATA, opaqueBytes(length))),
    ]);
}

/** What a TLS 1.3 server sends: ServerHello, change_cipher_spec, then encrypted records. */
export function tls13ServerFlight(applicationRecords: readonly number[]): Uint8Array {
    return concat([
        tlsRecord(HANDSHAKE, opaqueBytes(90)),
        tlsRecord(CHANGE_CIPHER_SPEC, Uint8Array.of(1)),
        ...applicationRecords.map((length) => tlsRecord(APPLICATION_DATA, opaqueBytes(length))),
    ]);
}

function u16(value: number): Uint8Array {
    return Uint8Array.of(value >> 8, value & 0xff);
}
