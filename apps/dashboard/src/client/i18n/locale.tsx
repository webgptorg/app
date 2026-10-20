import { UiProvider } from '@ptbk/ui';
import { createContext, Fragment, use, useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { getLocale, locales, setLocale } from '../../paraglide/runtime';
import type { Locale } from '../../paraglide/runtime';
import { createUiMessages } from '../core/ui-messages';

interface LocaleState {
    readonly locale: Locale;
    readonly locales: readonly Locale[];
    readonly changeLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleState | null>(null);

function applyToDocument(locale: Locale): void {
    document.documentElement.lang = locale;
}

/**
 * Paraglide resolves the first locale from the `ptbk_locale` cookie, then the browser's languages, then English.
 * Switching writes the cookie and re-renders the tree under the new locale instead of reloading the page; a completed
 * sign-in applies the account's saved locale the same way. Also feeds `@ptbk/ui` its translated `UiMessages`.
 */
export function LocaleProvider(props: { readonly children: ReactNode }) {
    const [locale, setLocaleState] = useState<Locale>(() => {
        const initial = getLocale();
        applyToDocument(initial);
        return initial;
    });
    const uiMessages = useMemo(() => createUiMessages(), []);

    const changeLocale = useCallback((next: Locale) => {
        void setLocale(next, { reload: false });
        applyToDocument(next);
        setLocaleState(next);
    }, []);

    const value = useMemo(() => ({ locale, locales, changeLocale }), [locale, changeLocale]);
    return (
        <LocaleContext value={value}>
            <UiProvider messages={uiMessages} locale={locale}>
                {/* Messages read the locale when they render, so a new key re-renders every one of them. */}
                <Fragment key={locale}>{props.children}</Fragment>
            </UiProvider>
        </LocaleContext>
    );
}

export function useLocale(): LocaleState {
    const state = use(LocaleContext);
    if (state === null) {
        throw new Error('useLocale needs a LocaleProvider');
    }
    return state;
}
