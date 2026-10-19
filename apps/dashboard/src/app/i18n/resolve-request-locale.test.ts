import { describe, expect, it } from 'vitest';

import { resolveRequestLocale } from './resolve-request-locale';

const none = { userLocale: null, cookieHeader: null, acceptLanguage: null };

describe('resolveRequestLocale', () => {
    it('falls back to English', () => {
        expect(resolveRequestLocale(none)).toBe('en');
    });

    it('prefers the user locale over cookie and Accept-Language', () => {
        expect(resolveRequestLocale({ userLocale: 'cs', cookieHeader: 'ptbk_locale=en', acceptLanguage: 'en' })).toBe(
            'cs',
        );
    });

    it('prefers the cookie over Accept-Language', () => {
        expect(
            resolveRequestLocale({ ...none, cookieHeader: 'other=1; ptbk_locale=cs', acceptLanguage: 'en-US,en' }),
        ).toBe('cs');
    });

    it('uses Accept-Language by quality, matching the primary language', () => {
        expect(resolveRequestLocale({ ...none, acceptLanguage: 'de;q=0.9, cs-CZ;q=0.95, en;q=0.5' })).toBe('cs');
        expect(resolveRequestLocale({ ...none, acceptLanguage: 'fr, en-GB;q=0.8, cs;q=0.7' })).toBe('en');
        expect(resolveRequestLocale({ ...none, acceptLanguage: 'cs;level=1, en;q=0.5' })).toBe('cs');
    });

    it('skips values that are not supported locales', () => {
        expect(
            resolveRequestLocale({ userLocale: 'de', cookieHeader: 'ptbk_locale=xx', acceptLanguage: 'cs;q=0.1' }),
        ).toBe('cs');
        expect(resolveRequestLocale({ ...none, acceptLanguage: 'cs;q=0, *' })).toBe('en');
    });
});
