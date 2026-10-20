import { applyTheme, persistThemePreference, readThemePreference, resolveTheme } from '@ptbk/ui';
import type { PreferenceStorage, ResolvedTheme, ThemePreference } from '@ptbk/ui';
import { createContext, use, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type { AppMatchMedia } from './browser';

const DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeState {
    readonly preference: ThemePreference;
    readonly resolved: ResolvedTheme;
    readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/**
 * Owns the theme after `main.tsx` applied the stored one before the first render. With `system`, it follows the
 * operating system's setting live.
 */
export function ThemeProvider(props: {
    readonly storage: PreferenceStorage | undefined;
    readonly matchMedia: AppMatchMedia;
    readonly children: ReactNode;
}) {
    const { storage, matchMedia } = props;
    const [preference, setPreferenceState] = useState<ThemePreference>(() => readThemePreference(storage));
    const subscribe = useCallback(
        (onChange: () => void) => {
            const query = matchMedia(DARK_QUERY);
            query.addEventListener('change', onChange);
            return () => {
                query.removeEventListener('change', onChange);
            };
        },
        [matchMedia],
    );
    const resolved = useSyncExternalStore(subscribe, () => resolveTheme(preference, matchMedia));

    useEffect(() => {
        applyTheme(resolved, document.documentElement, matchMedia);
    }, [resolved, matchMedia]);

    const setPreference = useCallback(
        (next: ThemePreference) => {
            persistThemePreference(storage, next);
            setPreferenceState(next);
        },
        [storage],
    );

    const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
    return <ThemeContext value={value}>{props.children}</ThemeContext>;
}

export function useThemePreference(): ThemeState {
    const state = use(ThemeContext);
    if (state === null) {
        throw new Error('useThemePreference needs a ThemeProvider');
    }
    return state;
}
