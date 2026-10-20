import { THEME_STORAGE_KEY } from '@ptbk/ui';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createFakeMatchMedia } from '../testing/fake-match-media';
import { createMemoryStorage, REFUSING_STORAGE } from '../testing/memory-storage';
import { renderWithProviders } from '../testing/render-with-providers';
import { ThemeProvider, useThemePreference } from './theme';

const DARK = '(prefers-color-scheme: dark)';

function ThemeProbe() {
    const { preference, resolved, setPreference } = useThemePreference();
    return (
        <div>
            <output>{`${preference} ${resolved}`}</output>
            <button
                type="button"
                onClick={() => {
                    setPreference('dark');
                }}
            >
                {'dark'}
            </button>
            <button
                type="button"
                onClick={() => {
                    setPreference('system');
                }}
            >
                {'system'}
            </button>
        </div>
    );
}

const html = document.documentElement;

describe('ThemeProvider', () => {
    it('follows the system by default, live', () => {
        const media = createFakeMatchMedia({ [DARK]: false });
        render(
            <ThemeProvider storage={createMemoryStorage()} matchMedia={media.matchMedia}>
                <ThemeProbe />
            </ThemeProvider>,
        );
        expect(screen.getByRole('status').textContent).toBe('system light');
        expect(html.classList.contains('dark')).toBe(false);

        act(() => {
            media.set(DARK, true);
        });
        expect(screen.getByRole('status').textContent).toBe('system dark');
        expect(html.classList.contains('dark')).toBe(true);
        expect(html.style.colorScheme).toBe('dark');
    });

    it('persists a chosen theme across a reload with the same storage and stops following the system', () => {
        const storage = createMemoryStorage();
        const media = createFakeMatchMedia({ [DARK]: false });
        const first = render(
            <ThemeProvider storage={storage} matchMedia={media.matchMedia}>
                <ThemeProbe />
            </ThemeProvider>,
        );
        act(() => {
            screen.getByRole('button', { name: 'dark' }).click();
        });
        expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
        expect(html.classList.contains('dark')).toBe(true);
        first.unmount();
        html.classList.remove('dark');

        render(
            <ThemeProvider storage={storage} matchMedia={media.matchMedia}>
                <ThemeProbe />
            </ThemeProvider>,
        );
        expect(screen.getByRole('status').textContent).toBe('dark dark');
        expect(html.classList.contains('dark')).toBe(true);
        act(() => {
            media.set(DARK, false);
        });
        expect(html.classList.contains('dark')).toBe(true);
    });

    it('applies the theme even when storage is refused', () => {
        render(
            <ThemeProvider storage={REFUSING_STORAGE} matchMedia={createFakeMatchMedia().matchMedia}>
                <ThemeProbe />
            </ThemeProvider>,
        );
        act(() => {
            screen.getByRole('button', { name: 'dark' }).click();
        });
        expect(screen.getByRole('status').textContent).toBe('dark dark');
        act(() => {
            screen.getByRole('button', { name: 'system' }).click();
        });
        expect(screen.getByRole('status').textContent).toBe('system light');
    });

    it('stops listening to the system once unmounted', () => {
        const media = createFakeMatchMedia();
        const query = media.matchMedia(DARK);
        const remove = vi.spyOn(query, 'removeEventListener');
        const matchMedia = vi.fn(() => query);
        const { unmount } = render(
            <ThemeProvider storage={createMemoryStorage()} matchMedia={matchMedia}>
                <ThemeProbe />
            </ThemeProvider>,
        );
        unmount();
        expect(remove).toHaveBeenCalled();
    });

    it('renders the app in the stored theme', async () => {
        renderWithProviders({ path: '/agents', theme: 'dark' });
        expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined();
        expect(html.classList.contains('dark')).toBe(true);
    });

    it('needs a provider', () => {
        expect(() => render(<ThemeProbe />)).toThrow(/ThemeProvider/);
    });
});
