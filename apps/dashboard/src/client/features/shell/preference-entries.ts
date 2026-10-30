import { THEME_PREFERENCES } from '@ptbk/ui';
import type { LanguageOption } from '@ptbk/ui';
import type { MenuEntry, ThemePreference } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import type { Locale } from '../../../paraglide/runtime';
import { useThemePreference } from '../../core/theme';

/** Each language in its own name, so it is recognisable whatever the current language is. */
export function localeLabel(locale: Locale): string {
    switch (locale) {
        case 'en':
            return m.locale_en({}, { locale: 'en' });
        case 'cs':
            return m.locale_cs({}, { locale: 'cs' });
    }
}

export function themeLabel(preference: ThemePreference): string {
    switch (preference) {
        case 'system':
            return m.theme_system();
        case 'light':
            return m.theme_light();
        case 'dark':
            return m.theme_dark();
    }
}

/** The app's languages for `LanguageSwitch`, each in its own name. */
export function languageOptions(locales: readonly Locale[]): LanguageOption<Locale>[] {
    return locales.map((code) => ({ code, name: localeLabel(code) }));
}

/** Theme choices; the language has its own switch in every header, so the menus offer only these. */
export function useThemeEntries(): MenuEntry[] {
    const { preference, setPreference } = useThemePreference();
    return [
        { kind: 'heading', id: 'theme', label: m.theme_label() },
        ...THEME_PREFERENCES.map((option): MenuEntry => ({
            kind: 'item',
            id: `theme-${option}`,
            label: themeLabel(option),
            checked: option === preference,
            onSelect: () => {
                setPreference(option);
            },
        })),
    ];
}
