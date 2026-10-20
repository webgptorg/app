import { z } from 'zod';

import { decodeBase64Url, encodeBase64Url } from './base64url';
import type { Bytes } from './bytes';

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

/** 26 lowercase base32 characters (130 bits of the key's SHA-256), see `deriveEngineId`. */
export const EngineId = z
    .string()
    .regex(/^[a-z2-7]{26}$/)
    .brand<'EngineId'>();
export type EngineId = z.infer<typeof EngineId>;

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
// The character classes are spelled out instead of using the `i` flag: with `u`, case folding would let the Kelvin
// sign (U+212A) match `k`, and `toLowerCase()` would then turn it into ASCII.
const HOSTNAME_PATTERN = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);
// Browsers (WHATWG URL) parse a host whose last label is a number, decimal or 0x-hex, as IPv4.
const ENDS_IN_NUMBER = /\.(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/;

function hostname() {
    return z
        .string()
        .max(253)
        .regex(HOSTNAME_PATTERN)
        .refine((value) => !ENDS_IN_NUMBER.test(value), 'IP literals are not hostnames')
        .toLowerCase();
}

/**
 * ASCII hostname (IDN must arrive as A-labels), lowercased, at most 253 characters, at least two labels of 1–63
 * `[a-z0-9-]` without a leading or trailing hyphen, no trailing dot. IPv4 literals are refused through their numeric
 * last label, IPv6 literals through `:` and brackets.
 */
export const Hostname = hostname().brand<'Hostname'>();
export type Hostname = z.infer<typeof Hostname>;

/**
 * The relay's own hostname (e.g. `relay-fsn.<domain>`), so a tunnel signature binds to the exact relay the engine
 * dialled. Same rules as `Hostname`, branded separately.
 */
export const RelayId = hostname().brand<'RelayId'>();
export type RelayId = z.infer<typeof RelayId>;

/** Strict SemVer 2.0 (the regex from semver.org), bounded like npm's semver. */
export const EngineVersion = z
    .string()
    .max(256)
    .regex(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    )
    .brand<'EngineVersion'>();
export type EngineVersion = z.infer<typeof EngineVersion>;

/** RFC 3339 in UTC (`Z`), any sub-second precision. */
export const Timestamp = z.iso.datetime().brand<'Timestamp'>();
export type Timestamp = z.infer<typeof Timestamp>;

function base64UrlOfLength(bytes: number) {
    return z
        .string()
        .length(Math.ceil((bytes * 4) / 3))
        .refine(
            (text) => {
                const decoded = decodeBase64Url(text);
                return decoded.kind === 'ok' && decoded.bytes.length === bytes;
            },
            `expected base64url of exactly ${String(bytes)} bytes`,
        );
}

/** Wire form of an Ed25519 public key: canonical base64url of exactly 32 bytes, no algorithm prefix (ADR 0010 §7). */
export const Ed25519PublicKey = base64UrlOfLength(ED25519_PUBLIC_KEY_BYTES).brand<'Ed25519PublicKey'>();
export type Ed25519PublicKey = z.infer<typeof Ed25519PublicKey>;

/** Wire form of an Ed25519 signature: canonical base64url of exactly 64 bytes, no algorithm prefix (ADR 0010 §7). */
export const Ed25519Signature = base64UrlOfLength(ED25519_SIGNATURE_BYTES).brand<'Ed25519Signature'>();
export type Ed25519Signature = z.infer<typeof Ed25519Signature>;

function assertLength(bytes: Uint8Array, expected: number, what: string): void {
    if (bytes.length !== expected) {
        throw new RangeError(`${what} must be ${String(expected)} bytes, got ${String(bytes.length)}`);
    }
}

function decodeBranded(text: string): Bytes {
    const decoded = decodeBase64Url(text);
    // Unreachable for a value that passed its schema; kept so a forged brand (a cast) fails loudly.
    if (decoded.kind === 'invalid') throw new TypeError('not base64url');
    return decoded.bytes;
}

/** Throws a RangeError unless `bytes` is 32 bytes long: that is a bug in the caller, not untrusted input. */
export function ed25519PublicKeyFromBytes(bytes: Uint8Array): Ed25519PublicKey {
    assertLength(bytes, ED25519_PUBLIC_KEY_BYTES, 'Ed25519 public key');
    return Ed25519PublicKey.parse(encodeBase64Url(bytes));
}

export function ed25519PublicKeyToBytes(publicKey: Ed25519PublicKey): Bytes {
    return decodeBranded(publicKey);
}

/** Throws a RangeError unless `bytes` is 64 bytes long: that is a bug in the caller, not untrusted input. */
export function ed25519SignatureFromBytes(bytes: Uint8Array): Ed25519Signature {
    assertLength(bytes, ED25519_SIGNATURE_BYTES, 'Ed25519 signature');
    return Ed25519Signature.parse(encodeBase64Url(bytes));
}

export function ed25519SignatureToBytes(signature: Ed25519Signature): Bytes {
    return decodeBranded(signature);
}
