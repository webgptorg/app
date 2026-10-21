import { describe, expect, it } from 'vitest';

import { findPlaintext } from './plaintext.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('findPlaintext', () => {
    it('reports the first occurrence of each needle in each haystack', () => {
        const hits = findPlaintext(
            [
                { label: 'a', bytes: encode('xx GET / HTTP/1.1 GET /') },
                { label: 'b', bytes: encode('nothing here') },
                { label: 'c', bytes: encode('data: {"x":1}') },
            ],
            ['GET /', 'HTTP/1.1', 'data: {'],
        );

        expect(hits).toEqual([
            { needle: 'GET /', label: 'a', offset: 3 },
            { needle: 'HTTP/1.1', label: 'a', offset: 9 },
            { needle: 'data: {', label: 'c', offset: 0 },
        ]);
    });

    it('matches needles as UTF-8', () => {
        const bytes = new Uint8Array([0xff, ...encode('kanárek')]);

        expect(findPlaintext([{ label: 'x', bytes }], ['nárek'])).toEqual([{ needle: 'nárek', label: 'x', offset: 3 }]);
    });

    it('searches a view through its byte offset', () => {
        const bytes = encode('canary-123 tail').subarray(7);

        expect(findPlaintext([{ label: 'x', bytes }], ['canary', '123'])).toEqual([
            { needle: '123', label: 'x', offset: 0 },
        ]);
    });

    it('refuses an empty needle', () => {
        expect(() => findPlaintext([], [''])).toThrow(RangeError);
    });
});
