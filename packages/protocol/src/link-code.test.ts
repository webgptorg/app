import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LINK_CODE_BYTES, LinkCode, generateLinkCode } from './link-code';
import type { Random } from './random';
import { createCryptoRandom } from './random';
import { createSeededRandom } from './testing/seeded-random';

// base32 of the 16 bytes 00..0f, computed with Python's base64.b32encode.
const CODE = 'aaaqeayeaudaocajbifqydiob4';

function fixedRandom(bytes: Uint8Array): Random {
    return { bytes: (length) => (length === bytes.length ? new Uint8Array(bytes) : new Uint8Array(length).fill(0xff)) };
}

describe('LinkCode', () => {
    it('accepts a canonical code', () => {
        expect(LinkCode.parse(CODE)).toBe(CODE);
    });

    it.each([
        ['25 characters', CODE.slice(0, 25)],
        ['27 characters', `${CODE}a`],
        ['uppercase', CODE.toUpperCase()],
        ['one uppercase letter', `A${CODE.slice(1)}`],
        ['padding', `${CODE}======`],
        ['padding in place of the last character', `${CODE.slice(0, 25)}=`],
        ['the digit 0', `0${CODE.slice(1)}`],
        ['the digit 1', `1${CODE.slice(1)}`],
        ['the digit 8', `8${CODE.slice(1)}`],
        ['the digit 9', `9${CODE.slice(1)}`],
        ['a non-canonical last character (trailing bits set)', `${CODE.slice(0, 25)}5`],
        ['a non-canonical last character b', `${CODE.slice(0, 25)}b`],
        ['a separator', `${CODE.slice(0, 13)}-${CODE.slice(13, 25)}`],
        ['surrounding whitespace', ` ${CODE}`],
        ['the empty string', ''],
    ])('rejects %s', (_, code) => {
        expect(LinkCode.safeParse(code).success).toBe(false);
    });

    it('accepts exactly the eight last characters with zero trailing bits', () => {
        const accepted = Array.from('abcdefghijklmnopqrstuvwxyz234567').filter(
            (last) => LinkCode.safeParse(`${CODE.slice(0, 25)}${last}`).success,
        );
        expect(accepted.join('')).toBe('aeimquy4');
    });
});

describe('generateLinkCode', () => {
    it('encodes 16 bytes from the Random port', () => {
        expect(LINK_CODE_BYTES).toBe(16);
        expect(generateLinkCode(fixedRandom(Uint8Array.from({ length: 16 }, (_, index) => index)))).toBe(CODE);
    });

    it('always parses, for any 128 bits', () => {
        fc.assert(
            fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (bytes) => {
                expect(LinkCode.safeParse(generateLinkCode(fixedRandom(bytes))).success).toBe(true);
            }),
        );
    });

    it('produces distinct codes from the crypto and seeded ports', () => {
        const crypto = createCryptoRandom();
        const seeded = createSeededRandom(7);
        expect(generateLinkCode(crypto)).not.toBe(generateLinkCode(crypto));
        expect(generateLinkCode(seeded)).not.toBe(generateLinkCode(seeded));
    });
});
