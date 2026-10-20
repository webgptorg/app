import type { Bytes } from './bytes';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Int8Array(128).fill(-1);
for (let value = 0; value < ALPHABET.length; value++) VALUES[ALPHABET.charCodeAt(value)] = value;

export type Base64StdDecode = { readonly kind: 'ok'; readonly bytes: Bytes } | { readonly kind: 'invalid' };

const INVALID: Base64StdDecode = Object.freeze({ kind: 'invalid' });

/**
 * RFC 4648 §4 standard base64 with `=` padding. Used only inside DSSE envelopes, which DSSE and Sigstore define this
 * way (ADR 0010 §6); every other byte string on the wire is base64url.
 */
export function encodeBase64Std(bytes: Uint8Array): string {
    let text = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
        const chars = Math.min(bytes.length - index, 3) + 1;
        for (let char = 0; char < 4; char++) {
            text += char < chars ? ALPHABET.charAt((chunk >>> (18 - 6 * char)) & 0x3f) : '=';
        }
    }
    return text;
}

/**
 * Accepts exactly the output of `encodeBase64Std`: length a multiple of 4, padding required and only at the end,
 * no `-`, `_` or whitespace, and zero unused trailing bits, so every byte string has one accepted encoding.
 */
export function decodeBase64Std(text: string): Base64StdDecode {
    if (text.length % 4 !== 0) return INVALID;
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    const data = text.length - padding;
    const bytes = new Uint8Array((text.length / 4) * 3 - padding);
    let buffer = 0;
    let bits = 0;
    let offset = 0;
    for (let index = 0; index < data; index++) {
        const value = VALUES[text.charCodeAt(index)] ?? -1;
        if (value < 0) return INVALID;
        buffer = ((buffer << 6) | value) & 0xfff;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes[offset++] = (buffer >>> bits) & 0xff;
        }
    }
    if ((buffer & ((1 << bits) - 1)) !== 0) return INVALID;
    return { kind: 'ok', bytes };
}
