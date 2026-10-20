import { useUiMessages } from '@ptbk/ui';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createMemoryStorage, REFUSING_STORAGE } from '../testing/memory-storage';
import { renderWithProviders } from '../testing/render-with-providers';
import { useAppLocale, LocaleProvider } from './locale';
import { LOCALE_STORAGE_KEY } from './locale-storage';

function LocaleProbe() {
    const { locale, locales, changeLocale } = useAppLocale();
    const messages = useUiMessages();
    return (
        <div>
            <output>{`${locale} ${messages.close()}`}</output>
            {locales.map((next) => (
                <button
                    key={next}
                    type="button"
                    onClick={() => {
                        changeLocale(next);
                    }}
                >
                    {next}
                </button>
            ))}
        </div>
    );
}

describe('LocaleProvider', () => {
    it('defaults to English, and a chosen language survives a reload with the same storage', () => {
        const storage = createMemoryStorage();
        const first = render(
            <LocaleProvider storage={storage}>
                <LocaleProbe />
            </LocaleProvider>,
        );
        expect(screen.getByRole('status').textContent).toBe('en Close');
        expect(document.documentElement.lang).toBe('en');

        act(() => {
            screen.getByRole('button', { name: 'cs' }).click();
        });
        expect(screen.getByRole('status').textContent).toBe('cs Zavřít');
        expect(document.documentElement.lang).toBe('cs');
        expect(storage.getItem(LOCALE_STORAGE_KEY)).toBe('cs');
        first.unmount();

        render(
            <LocaleProvider storage={storage}>
                <LocaleProbe />
            </LocaleProvider>,
        );
        expect(screen.getByRole('status').textContent).toBe('cs Zavřít');
        expect(document.documentElement.lang).toBe('cs');
    });

    it('still works when the browser refuses storage', () => {
        render(
            <LocaleProvider storage={REFUSING_STORAGE}>
                <LocaleProbe />
            </LocaleProvider>,
        );
        expect(screen.getByRole('status').textContent).toBe('en Close');
        act(() => {
            screen.getByRole('button', { name: 'cs' }).click();
        });
        expect(screen.getByRole('status').textContent).toBe('cs Zavřít');
    });

    it('ignores a stored value that is not a known locale', () => {
        render(
            <LocaleProvider storage={createMemoryStorage({ [LOCALE_STORAGE_KEY]: 'tlh' })}>
                <LocaleProbe />
            </LocaleProvider>,
        );
        expect(screen.getByRole('status').textContent).toBe('en Close');
    });

    it('renders the app in the stored language', async () => {
        renderWithProviders({ path: '/agents', locale: 'cs' });
        expect(await screen.findByRole('heading', { name: 'Agenti' })).toBeDefined();
        expect(document.documentElement.lang).toBe('cs');
    });

    it('needs a provider', () => {
        expect(() => render(<LocaleProbe />)).toThrow(/LocaleProvider/);
    });
});
