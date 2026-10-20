import { describe, expect, it, vi } from 'vitest';

import { applyTheme, persistThemePreference, readThemePreference, resolveTheme, THEME_STORAGE_KEY } from './preference';
import type { MatchMedia, PreferenceStorage } from './preference';

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Map<string, string> } {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value);
        },
    };
}

const prefersDark: MatchMedia = (query) => ({ matches: query === '(prefers-color-scheme: dark)' });
const prefersLight: MatchMedia = () => ({ matches: false });

describe('theme preference', () => {
    it('reads a stored preference and falls back to system for missing, unknown or unreadable values', () => {
        expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark');
        expect(readThemePreference(memoryStorage())).toBe('system');
        expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'sepia' }))).toBe('system');
        expect(readThemePreference(undefined)).toBe('system');
        const throwing: PreferenceStorage = {
            getItem: () => {
                throw new DOMException('denied', 'SecurityError');
            },
            setItem: () => {
                throw new DOMException('quota', 'QuotaExceededError');
            },
        };
        expect(readThemePreference(throwing)).toBe('system');
        expect(persistThemePreference(throwing, 'light')).toBe(false);
    });

    it('persists a preference so the next read returns it', () => {
        const storage = memoryStorage();
        expect(persistThemePreference(storage, 'light')).toBe(true);
        expect(readThemePreference(storage)).toBe('light');
        expect(persistThemePreference(undefined, 'light')).toBe(false);
    });

    it('resolves system through the colour-scheme media query', () => {
        expect(resolveTheme('system', prefersDark)).toBe('dark');
        expect(resolveTheme('system', prefersLight)).toBe('light');
        expect(resolveTheme('light', prefersDark)).toBe('light');
        expect(resolveTheme('dark', prefersLight)).toBe('dark');
    });

    it('sets the dark class and color-scheme on the root, and removes them again', () => {
        const root = document.createElement('html');
        expect(applyTheme('dark', root, prefersLight)).toBe('dark');
        expect(root.classList.contains('dark')).toBe(true);
        expect(root.style.colorScheme).toBe('dark');

        const matchMedia = vi.fn(prefersLight);
        expect(applyTheme('system', root, matchMedia)).toBe('light');
        expect(root.classList.contains('dark')).toBe(false);
        expect(root.style.colorScheme).toBe('light');
        expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    });
});
