import { describe, expect, it } from 'vitest';

import { ENGINE_LABEL_MAX_LENGTH, engineLabel, engineLabelSchema, normalizeEngineLabel } from './engine-label';

const ENGINE_ID = 'hd55ioeq5ltpqc7hnunajz4tnb';

describe('engineLabelSchema', () => {
    it.each(['Production', 'Produkce – Brno (2)', 'staging_eu-west.1', 'Kancelář #3 + backup', "Seb's box", '東京'])(
        'accepts %s',
        (label) => {
            expect(engineLabelSchema.parse(label)).toBe(label);
        },
    );

    it.each([
        ['empty', ''],
        ['too long', 'a'.repeat(ENGINE_LABEL_MAX_LENGTH + 1)],
        ['a leading space', ' Production'],
        ['a trailing space', 'Production '],
        ['a double space', 'Prod  EU'],
        ['a tab', 'Prod\tEU'],
        ['a newline', 'Prod\nEU'],
        ['markup', '<b>Prod</b>'],
        ['a URL', 'https://evil.example'],
        ['an email address', 'ops@example.com'],
        ['a quote', 'Prod "EU"'],
        ['a control character', 'Prod\u0000'],
        ['a zero-width joiner', 'Prod‍EU'],
        ['decomposed accents (not NFC)', 'Kancelár'.normalize('NFD')],
    ])('refuses %s', (_, label) => {
        expect(engineLabelSchema.safeParse(label).success).toBe(false);
    });

    it('allows exactly the maximum length', () => {
        expect(engineLabelSchema.safeParse('a'.repeat(ENGINE_LABEL_MAX_LENGTH)).success).toBe(true);
    });
});

describe('normalizeEngineLabel', () => {
    it('trims, collapses whitespace and composes, so typed input parses', () => {
        const typed = '  Kancelár \t\n Brno  ';
        expect(normalizeEngineLabel(typed)).toBe('Kancelár Brno');
        expect(engineLabelSchema.safeParse(normalizeEngineLabel(typed)).success).toBe(true);
    });
});

describe('engineLabel', () => {
    it('is the owner’s label, or the short ID with one ellipsis', () => {
        expect(engineLabel({ engineId: ENGINE_ID, label: 'Production' })).toBe('Production');
        expect(engineLabel({ engineId: ENGINE_ID, label: null })).toBe('hd55ioeq…');
    });
});
