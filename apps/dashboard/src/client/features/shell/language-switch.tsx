import { LanguageSwitch } from '@ptbk/ui';

import { useLocale } from '../../i18n/locale';
import { languageOptions } from './preference-entries';

/** The header's language control; switching keeps the `ptbk_locale` cookie and re-renders without a reload. */
export function HeaderLanguageSwitch() {
    const { locale, locales, changeLocale } = useLocale();
    return <LanguageSwitch languages={languageOptions(locales)} current={locale} onChange={changeLocale} />;
}
