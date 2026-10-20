import type { PreferenceStorage } from '@ptbk/ui';

import { defineCustomClientStrategy, isLocale } from '../paraglide/runtime';

export const LOCALE_STORAGE_KEY = 'ptbk.locale';

/**
 * Backs Paraglide's `custom-storage` strategy (project.inlang/paraglide.config.js), which comes before the browser's
 * preferred languages and English. Paraglide's own `localStorage` strategy reads storage unguarded on every message
 * call, so a browser that blocks site data would break every string; this one treats a refusal as "nothing stored"
 * and keeps the choice for the current page, and ignores a stored value that is not a known locale.
 */
export function installLocaleStorage(storage: PreferenceStorage | undefined): void {
    let chosen: string | undefined;
    const readStored = (): string | undefined => {
        try {
            const stored = storage?.getItem(LOCALE_STORAGE_KEY);
            return isLocale(stored) ? stored : undefined;
        } catch {
            return undefined;
        }
    };
    defineCustomClientStrategy('custom-storage', {
        getLocale: () => chosen ?? readStored(),
        setLocale: (locale) => {
            chosen = locale;
            try {
                storage?.setItem(LOCALE_STORAGE_KEY, locale);
            } catch {
                // The locale still applies to this page; it just will not survive a reload.
            }
        },
    });
}
