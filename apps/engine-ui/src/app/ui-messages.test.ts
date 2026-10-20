import type { UiMessages } from '@ptbk/ui';
import { describe, expect, it } from 'vitest';

import { locales } from '../paraglide/runtime';
import { installLocaleStorage, LOCALE_STORAGE_KEY } from './locale-storage';
import { createUiMessages } from './ui-messages';
import { createMemoryStorage } from '../testing/memory-storage';

const SAMPLE_PARAMS = { label: 'Ada', count: 3, phrase: 'delete', column: 'Name', code: 'ABCD-EFGH' };

function render(messages: UiMessages): Record<string, string> {
    return Object.fromEntries(
        Object.entries(messages).map(([key, message]) => [key, (message as (params: object) => string)(SAMPLE_PARAMS)]),
    );
}

describe('createUiMessages', () => {
    it.each(locales)('supplies every UiMessages string from the %s catalogue', (locale) => {
        installLocaleStorage(createMemoryStorage({ [LOCALE_STORAGE_KEY]: locale }));
        const rendered = render(createUiMessages());

        for (const [key, text] of Object.entries(rendered)) {
            expect(text.trim(), key).not.toBe('');
            expect(text, key).not.toMatch(/^ui_/);
        }
        expect(rendered['selectRow']).toContain('Ada');
        expect(rendered['totalItems']).toContain('3');
    });

    it('switches language with the stored locale', () => {
        installLocaleStorage(createMemoryStorage({ [LOCALE_STORAGE_KEY]: 'en' }));
        const english = createUiMessages().close();
        installLocaleStorage(createMemoryStorage({ [LOCALE_STORAGE_KEY]: 'cs' }));
        expect(createUiMessages().close()).not.toBe(english);
    });
});
