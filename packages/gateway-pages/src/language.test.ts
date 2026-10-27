import { describe, expect, it } from 'vitest';

import { pickGatewayLanguage } from './language';

describe('pickGatewayLanguage', () => {
    it.each([
        ['cs', 'cs'],
        ['cs-CZ', 'cs'],
        ['CS-cz,en;q=0.9', 'cs'],
        ['cs-CZ,cs;q=0.9,en;q=0.8', 'cs'],
        ['de-DE,cs;q=0.8', 'cs'],
        ['en;q=0.5,cs;q=0.6', 'cs'],
        ['cs, en', 'cs'],
        ['cs;q=0.5,en;q=0', 'cs'],
        ['cs,*;q=0.1', 'cs'],
        ['cs-CZ, ,en', 'cs'],
    ])('picks Czech for %j', (header, expected) => {
        expect(pickGatewayLanguage(header)).toBe(expected);
    });

    it.each([
        [null],
        [''],
        ['en'],
        ['en-US,en;q=0.9,cs;q=0.8'],
        ['en, cs'],
        ['sk'],
        ['sk-SK,de;q=0.9'],
        ['cs;q=0'],
        ['*'],
        ['*;q=0.5,cs;q=0.4'],
        ['en;q=0.8,en-GB;q=0.9,cs;q=0.85'],
        ['czech'],
        ['de'],
    ])('picks English for %j', (header) => {
        expect(pickGatewayLanguage(header)).toBe('en');
    });

    it.each([
        ['cs;q=2'],
        ['cs;q=0.5000'],
        ['cs;level=1'],
        ['cs;q=0.5;q=0.4'],
        ['cs_CZ'],
        ['cs-'],
        ['c$'],
        ['abcdefghi'],
        [`cs,${'x'.repeat(1100)}`],
        [`${'cs-aaaaaaaa,'.repeat(100)}en;q=0.1`],
    ])('falls back to English for malformed or oversized %j', (header) => {
        expect(pickGatewayLanguage(header)).toBe('en');
    });
});
