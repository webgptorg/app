import { describe, expect, it } from 'vitest';

import cs from '../../messages/cs.json';
import en from '../../messages/en.json';
import { m } from '../paraglide/messages';

/** Keys present in one catalogue but not the other; `$schema` is editor metadata, not a message. */
function catalogueKeyMismatch(source: object, translation: object): string[] {
    const keys = (catalogue: object) => new Set(Object.keys(catalogue).filter((key) => key !== '$schema'));
    const sourceKeys = keys(source);
    const translationKeys = keys(translation);
    return [
        ...[...sourceKeys].filter((key) => !translationKeys.has(key)).map((key) => `missing in translation: ${key}`),
        ...[...translationKeys].filter((key) => !sourceKeys.has(key)).map((key) => `not in source: ${key}`),
    ].sort();
}

describe('message catalogues', () => {
    it('have the same keys in English and Czech', () => {
        expect(catalogueKeyMismatch(en, cs)).toEqual([]);
    });

    it('the key check catches a missing and an extra key', () => {
        expect(catalogueKeyMismatch({ a: 'A', b: 'B' }, { a: 'A', c: 'C' })).toEqual([
            'missing in translation: b',
            'not in source: c',
        ]);
    });

    it.each([
        [0, '0 vybraných položek', '0 položek'],
        [1, '1 vybraná položka', '1 položka'],
        [2, '2 vybrané položky', '2 položky'],
        [5, '5 vybraných položek', '5 položek'],
    ])('pluralise Czech for %i', (count, selected, total) => {
        expect(m.ui_selected_count({ count }, { locale: 'cs' })).toBe(selected);
        expect(m.ui_total_items({ count }, { locale: 'cs' })).toBe(total);
    });

    it.each([
        [0, '0 selected', '0 items'],
        [1, '1 selected', '1 item'],
        [2, '2 selected', '2 items'],
    ])('pluralise English for %i', (count, selected, total) => {
        expect(m.ui_selected_count({ count }, { locale: 'en' })).toBe(selected);
        expect(m.ui_total_items({ count }, { locale: 'en' })).toBe(total);
    });
});
