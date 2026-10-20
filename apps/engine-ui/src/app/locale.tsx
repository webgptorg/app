import type { PreferenceStorage } from '@ptbk/ui';
import { UiProvider } from '@ptbk/ui';
import { createContext, Fragment, use, useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { getLocale, locales, setLocale } from '../paraglide/runtime';
import type { Locale } from '../paraglide/runtime';
import { installLocaleStorage } from './locale-storage';
import { createUiMessages } from './ui-messages';

interface LocaleState {
    readonly locale: Locale;
    readonly locales: readonly Locale[];
    readonly changeLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleState | null>(null);

export interface LocaleProviderProps {
    readonly storage: PreferenceStorage | undefined;
    readonly children: ReactNode;
}

/**
 * Resolves the locale from storage, then the browser's languages, then English (no cookie, no URL prefix), keeps
 * `<html lang>` in step and feeds `@ptbk/ui` the translated `UiMessages`. Switching re-renders the tree under the new
 * locale instead of reloading the page.
 */
export function LocaleProvider({ storage, children }: LocaleProviderProps) {
    const [locale, setLocaleState] = useState<Locale>(() => {
        installLocaleStorage(storage);
        const initial = getLocale();
        document.documentElement.lang = initial;
        return initial;
    });
    const uiMessages = useMemo(() => createUiMessages(), []);

    const changeLocale = useCallback((next: Locale) => {
        void setLocale(next, { reload: false });
        document.documentElement.lang = next;
        setLocaleState(next);
    }, []);

    const value = useMemo(() => ({ locale, locales, changeLocale }), [locale, changeLocale]);
    return (
        <LocaleContext value={value}>
            <UiProvider messages={uiMessages} locale={locale}>
                {/* Messages read the locale when they render, so a new key re-renders every one of them. */}
                <Fragment key={locale}>{children}</Fragment>
            </UiProvider>
        </LocaleContext>
    );
}

export function useAppLocale(): LocaleState {
    const state = use(LocaleContext);
    if (state === null) throw new Error('useAppLocale() needs a <LocaleProvider> above it');
    return state;
}
