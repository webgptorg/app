import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from './base64url';
import { utf8Encode } from './bytes';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function decoded(text: string): number[] | 'invalid' {
    const result = decodeBase64Url(text);
    return result.kind === 'ok' ? [...result.bytes] : 'invalid';
}

describe('base64url', () => {
    // RFC 4648 §10, without padding.
    it.each([
        ['', ''],
        ['f', 'Zg'],
        ['fo', 'Zm8'],
        ['foo', 'Zm9v'],
        ['foob', 'Zm9vYg'],
        ['fooba', 'Zm9vYmE'],
        ['foobar', 'Zm9vYmFy'],
    ])('%j <-> %j', (input, encoded) => {
        expect(encodeBase64Url(utf8Encode(input))).toBe(encoded);
        expect(decoded(encoded)).toEqual([...utf8Encode(input)]);
    });

    it('uses the URL-safe alphabet', () => {
        expect(encodeBase64Url(Uint8Array.of(0xfb, 0xff, 0xbf))).toBe('-_-_');
        expect(decoded('-_-_')).toEqual([0xfb, 0xff, 0xbf]);
    });

    it.each([
        ['padding', 'Zg=='],
        ['single padding', 'Zm8='],
        ['standard alphabet +', '+_-_'],
        ['standard alphabet /', '-/-_'],
        ['space', 'Zm9v Yg'],
        ['newline', 'Zm9v\nYg'],
        ['tab', '\tZm9v'],
        ['length 1 mod 4', 'Zm9vY'],
        ['single character', 'Z'],
        ['non-zero trailing bits (2 chars)', 'Zh'],
        ['non-zero trailing bits (3 chars)', 'Zm9'],
        ['non-ASCII', 'Zm9vÿ'],
        ['astral', 'Zm9v😀'],
        ['NUL', 'Zm9v\0'],
    ])('rejects %s', (_, text) => {
        expect(decodeBase64Url(text)).toEqual({ kind: 'invalid' });
    });

    it('round-trips arbitrary bytes', () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
                const result = decodeBase64Url(encodeBase64Url(bytes));
                expect(result.kind === 'ok' && [...result.bytes]).toEqual([...bytes]);
            }),
        );
    });

    it('never throws on arbitrary strings', () => {
        fc.assert(
            fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (text) => {
                expect(['ok', 'invalid']).toContain(decodeBase64Url(text).kind);
            }),
        );
    });

    it('accepts exactly one encoding per byte string', () => {
        const nearlyBase64 = fc.string({
            unit: fc.constantFrom(...Array.from(ALPHABET), '=', '+', '/', ' ', '\n'),
            maxLength: 24,
        });
        fc.assert(
            fc.property(nearlyBase64, (text) => {
                const result = decodeBase64Url(text);
                if (result.kind === 'ok') expect(encodeBase64Url(result.bytes)).toBe(text);
            }),
            { numRuns: 2000 },
        );
    });

    it('rejects every non-canonical variant of a valid encoding', () => {
        const variants = (encoded: string): string[] => {
            const result = [`${encoded}=`, `${encoded}==`, ` ${encoded}`, `${encoded}\n`];
            for (let index = 0; index < encoded.length; index++) {
                const char = encoded.charAt(index);
                const replace = (other: string): string => encoded.slice(0, index) + other + encoded.slice(index + 1);
                if (char === '-') result.push(replace('+'));
                if (char === '_') result.push(replace('/'));
                result.push(encoded.slice(0, index) + ' ' + encoded.slice(index));
            }
            const unusedBits = (encoded.length * 6) % 8;
            for (let bit = 0; bit < unusedBits; bit++) {
                const last = ALPHABET.indexOf(encoded.charAt(encoded.length - 1));
                result.push(encoded.slice(0, -1) + ALPHABET.charAt(last ^ (1 << bit)));
            }
            return result;
        };
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
                const encoded = encodeBase64Url(bytes);
                for (const variant of variants(encoded)) {
                    expect(decodeBase64Url(variant)).toEqual({ kind: 'invalid' });
                }
            }),
        );
    });
});
