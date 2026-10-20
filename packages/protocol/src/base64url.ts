import type { Bytes } from './bytes';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALUES = new Int8Array(128).fill(-1);
for (let value = 0; value < ALPHABET.length; value++) VALUES[ALPHABET.charCodeAt(value)] = value;

export type Base64UrlDecode = { readonly kind: 'ok'; readonly bytes: Bytes } | { readonly kind: 'invalid' };

const INVALID: Base64UrlDecode = Object.freeze({ kind: 'invalid' });

/** RFC 4648 §5 base64url without padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
    let text = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
        const chars = Math.min(bytes.length - index, 3) + 1;
        for (let char = 0; char < chars; char++) {
            text += ALPHABET.charAt((chunk >>> (18 - 6 * char)) & 0x3f);
        }
    }
    return text;
}

/**
 * Accepts exactly the output of `encodeBase64Url`: no padding, `+`, `/` or whitespace, no length ≡ 1 (mod 4), and the
 * unused trailing bits must be zero, so every byte string has one accepted encoding.
 */
export function decodeBase64Url(text: string): Base64UrlDecode {
    if (text.length % 4 === 1) return INVALID;
    const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
    let buffer = 0;
    let bits = 0;
    let offset = 0;
    for (let index = 0; index < text.length; index++) {
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
