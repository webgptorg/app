import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeLocalStorage } from './storage';

describe('safeLocalStorage', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns the browser storage', () => {
        expect(safeLocalStorage()).toBe(window.localStorage);
    });

    it('returns undefined when the browser refuses access', () => {
        vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        expect(safeLocalStorage()).toBeUndefined();
    });
});
