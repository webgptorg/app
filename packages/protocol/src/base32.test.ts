import { describe, expect, it } from 'vitest';
import { encodeBase32Lower } from './base32';
import { utf8Encode } from './bytes';

describe('encodeBase32Lower', () => {
    // RFC 4648 §10, lowercased and without padding.
    it.each([
        ['', ''],
        ['f', 'my'],
        ['fo', 'mzxq'],
        ['foo', 'mzxw6'],
        ['foob', 'mzxw6yq'],
        ['fooba', 'mzxw6ytb'],
        ['foobar', 'mzxw6ytboi'],
    ])('%j -> %j', (input, expected) => {
        expect(encodeBase32Lower(utf8Encode(input))).toBe(expected);
    });

    it('uses the whole alphabet', () => {
        expect(
            encodeBase32Lower(
                Uint8Array.of(
                    0x00,
                    0x44,
                    0x32,
                    0x14,
                    0xc7,
                    0x42,
                    0x54,
                    0xb6,
                    0x35,
                    0xcf,
                    0x84,
                    0x65,
                    0x3a,
                    0x56,
                    0xd7,
                    0xc6,
                    0x75,
                    0xbe,
                    0x77,
                    0xdf,
                ),
            ),
        ).toBe('abcdefghijklmnopqrstuvwxyz234567');
    });
});
