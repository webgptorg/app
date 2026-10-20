import type { ThemePreference } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import type { Locale } from '../../paraglide/runtime';

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
