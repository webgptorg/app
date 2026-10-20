import { THEME_PREFERENCES } from '@ptbk/ui';
import type { MenuEntry, ThemePreference } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import type { Locale } from '../../../paraglide/runtime';
import { useThemePreference } from '../../core/theme';
import { useLocale } from '../../i18n/locale';

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

/** Language and theme choices, shared by the signed-in user menu and the signed-out preferences menu. */
export function usePreferenceEntries(): MenuEntry[] {
    const { locale, locales, changeLocale } = useLocale();
    const { preference, setPreference } = useThemePreference();
    return [
        { kind: 'heading', id: 'language', label: m.language_label() },
        ...locales.map((option): MenuEntry => ({
            kind: 'item',
            id: `locale-${option}`,
            label: localeLabel(option),
            checked: option === locale,
            onSelect: () => {
                changeLocale(option);
            },
        })),
        { kind: 'separator', id: 'theme-separator' },
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
