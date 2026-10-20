export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = 'light' | 'dark';

/** The storage key apps persist the preference under. */
export const THEME_STORAGE_KEY = 'ptbk.theme';

/** A `localStorage`-shaped store the app injects; reading or writing may throw (private mode, blocked storage). */
export interface PreferenceStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export type MatchMedia = (query: string) => Pick<MediaQueryList, 'matches'>;

const DARK_QUERY = '(prefers-color-scheme: dark)';

function isThemePreference(value: unknown): value is ThemePreference {
    return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** The stored preference, or `system` when there is none, it is unknown, or storage refuses to answer. */
export function readThemePreference(storage: PreferenceStorage | undefined): ThemePreference {
    try {
        const stored = storage?.getItem(THEME_STORAGE_KEY);
        return isThemePreference(stored) ? stored : 'system';
    } catch {
        return 'system';
    }
}

/** Returns whether the preference was stored; the theme still applies for this page when it was not. */
export function persistThemePreference(storage: PreferenceStorage | undefined, preference: ThemePreference): boolean {
    try {
        storage?.setItem(THEME_STORAGE_KEY, preference);
        return storage !== undefined;
    } catch {
        return false;
    }
}

export function resolveTheme(preference: ThemePreference, matchMedia: MatchMedia): ResolvedTheme {
    if (preference !== 'system') return preference;
    return matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Sets the `.dark` class and `color-scheme` on `root` (the `<html>` element). Apps call it as the first statement of
 * their entry module, because the engine's CSP allows no inline script that could run earlier.
 */
export function applyTheme(
    preference: ThemePreference,
    root: Pick<HTMLElement, 'classList' | 'style'>,
    matchMedia: MatchMedia,
): ResolvedTheme {
    const theme = resolveTheme(preference, matchMedia);
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    return theme;
}
