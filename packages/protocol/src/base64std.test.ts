import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeBase64Std, encodeBase64Std } from './base64std';
import { utf8Encode } from './bytes';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

function decoded(text: string): number[] | 'invalid' {
    const result = decodeBase64Std(text);
    return result.kind === 'ok' ? [...result.bytes] : 'invalid';
}

describe('standard base64', () => {
    // RFC 4648 §10.
    it.each([
        ['', ''],
        ['f', 'Zg=='],
        ['fo', 'Zm8='],
        ['foo', 'Zm9v'],
        ['foob', 'Zm9vYg=='],
        ['fooba', 'Zm9vYmE='],
        ['foobar', 'Zm9vYmFy'],
    ])('%j <-> %j', (input, encoded) => {
        expect(encodeBase64Std(utf8Encode(input))).toBe(encoded);
        expect(decoded(encoded)).toEqual([...utf8Encode(input)]);
    });

    it('uses the standard alphabet', () => {
        expect(encodeBase64Std(Uint8Array.of(0xfb, 0xff, 0xbf))).toBe('+/+/');
        expect(decoded('+/+/')).toEqual([0xfb, 0xff, 0xbf]);
    });

    it.each([
        ['base64url -', '-/+/'],
        ['base64url _', '+_+/'],
        ['missing padding (2 chars)', 'Zg'],
        ['missing padding (3 chars)', 'Zm8'],
        ['space', 'Zm9v Yg=='],
        ['newline', 'Zm9v\nYg=='],
        ['tab', '\tZm9vYg='],
        ['non-zero trailing bits (2 chars)', 'Zh=='],
        ['non-zero trailing bits (3 chars)', 'Zm9='],
        ['padding in the middle', 'Zg==Zm9v'],
        ['padding inside a quantum', 'Zm=v'],
        ['three padding characters', 'A==='],
        ['only padding', '===='],
        ['length 5', 'Zm9vY'],
        ['length 6', 'Zm9vYg'],
        ['single character', 'Z'],
        ['non-ASCII', 'Zm9vÿA=='],
        ['astral', 'Zm9v😀=='],
        ['NUL', 'Zm9v\0A=='],
    ])('rejects %s', (_, text) => {
        expect(decodeBase64Std(text)).toEqual({ kind: 'invalid' });
    });

    it('round-trips arbitrary bytes', () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
                expect(decoded(encodeBase64Std(bytes))).toEqual([...bytes]);
            }),
        );
    });

    it('accepts exactly one encoding of each byte string', () => {
        fc.assert(
            fc.property(fc.string({ unit: fc.constantFrom(...ALPHABET.split('')), maxLength: 16 }), (text) => {
                const result = decodeBase64Std(text);
                if (result.kind === 'ok') expect(encodeBase64Std(result.bytes)).toBe(text);
            }),
            { numRuns: 2000 },
        );
    });
});
