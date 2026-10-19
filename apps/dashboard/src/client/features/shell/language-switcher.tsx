import { useId } from 'react';

import { m } from '../../../paraglide/messages';
import type { Locale } from '../../../paraglide/runtime';
import { useLocale } from '../../i18n/locale';

const LOCALE_NAMES: Readonly<Record<Locale, () => string>> = {
    en: () => m.locale_en(),
    cs: () => m.locale_cs(),
};

export function LanguageSwitcher() {
    const { locale, locales, changeLocale } = useLocale();
    const id = useId();
    return (
        <div className="flex items-center gap-2 text-sm">
            <label htmlFor={id}>{m.language_label()}</label>
            <select
                id={id}
                className="rounded border border-neutral-300 bg-white px-2 py-1"
                value={locale}
                onChange={(event) => {
                    const next = locales.find((candidate) => candidate === event.target.value);
                    if (next !== undefined) {
                        changeLocale(next);
                    }
                }}
            >
                {locales.map((candidate) => (
                    <option key={candidate} value={candidate} lang={candidate}>
                        {LOCALE_NAMES[candidate]()}
                    </option>
                ))}
            </select>
        </div>
    );
}
