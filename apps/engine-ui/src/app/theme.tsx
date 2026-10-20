import { applyTheme, persistThemePreference, readThemePreference, resolveTheme } from '@ptbk/ui';
import type { PreferenceStorage, ResolvedTheme, ThemePreference } from '@ptbk/ui';
import { createContext, use, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

/** `window.matchMedia`, injected so tests can drive the system theme. */
export type ThemeMatchMedia = (
    query: string,
) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

const DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeState {
    readonly preference: ThemePreference;
    readonly resolved: ResolvedTheme;
    readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export interface ThemeProviderProps {
    readonly storage: PreferenceStorage | undefined;
    readonly matchMedia: ThemeMatchMedia;
    readonly children: ReactNode;
}

/**
 * Owns the theme after `main.tsx` applied the stored one before the first render. With `system`, it follows the
 * operating system's setting live.
 */
export function ThemeProvider({ storage, matchMedia, children }: ThemeProviderProps) {
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
    // Read through `resolveTheme` so the snapshot is a stable string, and only `system` depends on the media query.
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
    return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useThemePreference(): ThemeState {
    const state = use(ThemeContext);
    if (state === null) throw new Error('useThemePreference() needs a <ThemeProvider> above it');
    return state;
}
