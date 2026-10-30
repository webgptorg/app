import { LanguageSwitch } from '@ptbk/ui';

import { useAppLocale } from '../../app/locale';
import { localeLabel } from '../settings/preference-labels';

/** The page language, one click from anywhere: switches in place and is remembered on this device. */
export function ShellLanguageSwitch({ align = 'end' }: { readonly align?: 'start' | 'end' }) {
    const { locale, locales, changeLocale } = useAppLocale();
    return (
        <LanguageSwitch
            languages={locales.map((code) => ({ code, name: localeLabel(code) }))}
            current={locale}
            onChange={changeLocale}
            align={align}
        />
    );
}
