import { describe, expect, it } from 'vitest';
import { bytesEqual, concatBytes, utf8Encode } from './bytes';

describe('bytes', () => {
    it('encodes UTF-8', () => {
        expect([...utf8Encode('aá€😀')]).toEqual([0x61, 0xc3, 0xa1, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
        expect(utf8Encode('').length).toBe(0);
    });

    it('concatenates into a fresh ArrayBuffer-backed array', () => {
        const a = Uint8Array.of(1, 2);
        const result = concatBytes(a, new Uint8Array(0), Uint8Array.of(3));
        expect([...result]).toEqual([1, 2, 3]);
        expect(result.buffer).toBeInstanceOf(ArrayBuffer);
        a[0] = 9;
        expect(result[0]).toBe(1);
        expect(concatBytes().length).toBe(0);
    });

    it('compares by length and content', () => {
        expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
        expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
        expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
        expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0))).toBe(false);
        expect(bytesEqual(Uint8Array.of(1, 2, 0), Uint8Array.of(1, 2))).toBe(false);
    });
});
