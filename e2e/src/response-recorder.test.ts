import { describe, expect, it } from 'vitest';

import { isTextLike, responsesContaining } from './response-recorder.ts';

describe('isTextLike', () => {
    it('reads JSON, problem details, text and event streams', () => {
        for (const type of [
            'application/json',
            'application/json; charset=utf-8',
            'application/problem+json',
            'text/html; charset=utf-8',
            'text/event-stream',
            'application/javascript',
        ]) {
            expect(isTextLike(type), type).toBe(true);
        }
    });

    it('skips binary bodies', () => {
        for (const type of ['image/png', 'application/octet-stream', 'application/zstd', 'font/woff2', '']) {
            expect(isTextLike(type), type).toBe(false);
        }
    });
});

describe('responsesContaining', () => {
    it('names the responses whose body holds the needle', () => {
        const recorded = [
            { url: 'https://e/api/v1/secrets', status: 200, contentType: 'application/json', body: '{"name":"A"}' },
            { url: 'https://e/api/v1/me', status: 200, contentType: 'application/json', body: '{}' },
        ];
        expect(responsesContaining(recorded, '"A"')).toEqual(['https://e/api/v1/secrets (200)']);
        expect(responsesContaining(recorded, 'canary')).toEqual([]);
    });
});
