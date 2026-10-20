import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeLocalStorage } from './storage';
import { createUiMessages } from './ui-messages';

describe('safeLocalStorage', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('is the browser’s storage, or undefined when site data is blocked', () => {
        expect(safeLocalStorage()).toBe(window.localStorage);
        vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        expect(safeLocalStorage()).toBeUndefined();
    });
});

describe('UiMessages from the catalogue', () => {
    it('gives every @ptbk/ui string a non-empty translation', () => {
        const params = { phrase: 'x', count: 2, label: 'Row', column: 'Name', code: 'ABCD' };
        for (const [name, message] of Object.entries(createUiMessages())) {
            const text = (message as (input: typeof params) => string)(params);
            expect(text.trim(), name).not.toBe('');
        }
    });
});
