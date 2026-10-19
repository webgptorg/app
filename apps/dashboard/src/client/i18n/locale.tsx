import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { getLocale, locales, setLocale, type Locale } from '../../paraglide/runtime';

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
 * Switching writes the cookie and re-renders the tree under the new locale instead of reloading the page.
 * Once sessions exist (D-02), the signed-in user's locale is applied through `changeLocale`.
 */
export function LocaleProvider(props: { readonly children: ReactNode }) {
    const [locale, setLocaleState] = useState<Locale>(() => {
        const initial = getLocale();
        applyToDocument(initial);
        return initial;
    });

    const changeLocale = useCallback((next: Locale) => {
        void setLocale(next, { reload: false });
        applyToDocument(next);
        setLocaleState(next);
    }, []);

    const value = useMemo(() => ({ locale, locales, changeLocale }), [locale, changeLocale]);
    return (
        <LocaleContext value={value}>
            {/* Messages read the locale when they render, so a new key re-renders every one of them. */}
            <Fragment key={locale}>{props.children}</Fragment>
        </LocaleContext>
    );
}

export function useLocale(): LocaleState {
    const state = useContext(LocaleContext);
    if (state === null) {
        throw new Error('useLocale needs a LocaleProvider');
    }
    return state;
}
