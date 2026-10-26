import type { Bytes } from '@ptbk/protocol';
import { concatBytes, utf8Encode } from '@ptbk/protocol';

/**
 * Just enough DER to mint certificates, SCTs and RFC 3161 tokens. Everything is minimal-length DER, because
 * `@sigstore/core` re-encodes parsed structures before checking signatures over them (the SCT's precertificate, a
 * timestamp's signed attributes): a non-canonical encoding would verify differently there than here.
 */

const TAG = Object.freeze({
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
} as const);

function encodeLength(length: number): Bytes {
    if (length < 0x80) return Uint8Array.of(length);
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest = Math.floor(rest / 0x100)) bytes.unshift(rest % 0x100);
    return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, ...contents: readonly Uint8Array[]): Bytes {
    const value = concatBytes(...contents);
    return concatBytes(Uint8Array.of(tag), encodeLength(value.length), value);
}

export function sequence(...items: readonly Uint8Array[]): Bytes {
    return tlv(TAG.sequence, ...items);
}

/** A SET OF with the items in the given order; callers pass them already sorted where DER requires it. */
export function set(...items: readonly Uint8Array[]): Bytes {
    return tlv(TAG.set, ...items);
}

/** `[number] EXPLICIT`. */
export function explicit(number: number, ...items: readonly Uint8Array[]): Bytes {
    return tlv(0xa0 | number, ...items);
}

/** An unsigned INTEGER from a safe integer or from big-endian magnitude bytes (serials, ECDSA `r` and `s`). */
export function integer(value: number | Uint8Array): Bytes {
    let magnitude: Uint8Array;
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0)
            throw new RangeError('integer must be a non-negative safe integer');
        const bytes: number[] = [];
        for (let rest = value; rest > 0; rest = Math.floor(rest / 0x100)) bytes.unshift(rest % 0x100);
        magnitude = Uint8Array.from(bytes);
    } else {
        let start = 0;
        while (start < value.length && value[start] === 0) start += 1;
        magnitude = value.subarray(start);
    }
    if (magnitude.length === 0) return tlv(TAG.integer, Uint8Array.of(0));
    return (magnitude[0] ?? 0) >= 0x80 ? tlv(TAG.integer, Uint8Array.of(0), magnitude) : tlv(TAG.integer, magnitude);
}

export function boolean(value: boolean): Bytes {
    return tlv(TAG.boolean, Uint8Array.of(value ? 0xff : 0x00));
}

function base128(arc: number): number[] {
    const bytes = [arc % 0x80];
    for (let rest = Math.floor(arc / 0x80); rest > 0; rest = Math.floor(rest / 0x80))
        bytes.unshift(0x80 | (rest % 0x80));
    return bytes;
}

export function oid(dotted: string): Bytes {
    const arcs = dotted.split('.').map(Number);
    const [first, second, ...rest] = arcs;
    if (
        first === undefined ||
        second === undefined ||
        arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0) ||
        first > 2 ||
        (first < 2 && second >= 40)
    ) {
        throw new RangeError(`not an object identifier: ${dotted}`);
    }
    return tlv(TAG.oid, Uint8Array.from([first * 40 + second, ...rest].flatMap(base128)));
}

export function utf8String(text: string): Bytes {
    return tlv(TAG.utf8String, utf8Encode(text));
}

export function octetString(bytes: Uint8Array): Bytes {
    return tlv(TAG.octetString, bytes);
}

export function bitString(bytes: Uint8Array, unusedBits = 0): Bytes {
    return tlv(TAG.bitString, Uint8Array.of(unusedBits), bytes);
}

function digits(value: number, width: number): string {
    return String(value).padStart(width, '0');
}

function timeText(date: Date, yearWidth: 2 | 4): string {
    if (Number.isNaN(date.getTime())) throw new RangeError('invalid date');
    const year = date.getUTCFullYear();
    return [
        yearWidth === 2 ? digits(year % 100, 2) : digits(year, 4),
        digits(date.getUTCMonth() + 1, 2),
        digits(date.getUTCDate(), 2),
        digits(date.getUTCHours(), 2),
        digits(date.getUTCMinutes(), 2),
        digits(date.getUTCSeconds(), 2),
        'Z',
    ].join('');
}

/** GeneralizedTime to the second, as RFC 3161 `genTime` and X.509 dates from 2050 on are written. */
export function generalizedTime(date: Date): Bytes {
    return tlv(TAG.generalizedTime, utf8Encode(timeText(date, 4)));
}

/** An X.509 `Time`: UTCTime for 1950 to 2049, GeneralizedTime otherwise (RFC 5280 §4.1.2.5). */
export function x509Time(date: Date): Bytes {
    const year = date.getUTCFullYear();
    return year >= 1950 && year < 2050 ? tlv(TAG.utcTime, utf8Encode(timeText(date, 2))) : generalizedTime(date);
}

/** WebCrypto signs ECDSA as `r || s`; X.509, SCTs, Rekor and CMS all carry `SEQUENCE { r INTEGER, s INTEGER }`. */
export function ecdsaSignatureToDer(raw: Uint8Array): Bytes {
    if (raw.length === 0 || raw.length % 2 !== 0) throw new RangeError('not a raw ECDSA signature');
    const half = raw.length / 2;
    return sequence(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
}
