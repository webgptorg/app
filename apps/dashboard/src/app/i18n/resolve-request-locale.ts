import { baseLocale, cookieName, toLocale, type Locale } from '../../paraglide/runtime';

export interface LocaleSources {
    /** The signed-in user's saved locale (from D-02 on). */
    readonly userLocale: string | null;
    readonly cookieHeader: string | null;
    readonly acceptLanguage: string | null;
}

function fromCookie(cookieHeader: string | null): Locale | undefined {
    for (const part of cookieHeader?.split(';') ?? []) {
        const [name, value] = part.split('=', 2).map((piece) => piece.trim());
        if (name === cookieName) {
            return toLocale(value);
        }
    }
    return undefined;
}

/** Highest `q` first; a tag matches by full tag, then by its primary language (`cs-CZ` → `cs`). */
function fromAcceptLanguage(header: string | null): Locale | undefined {
    const ranges = (header ?? '')
        .split(',')
        .map((range, order) => {
            const [tag = '', ...params] = range.trim().split(';');
            const q = params.map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param)?.[1]).find((v) => v !== undefined);
            return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), order };
        })
        .filter(({ tag, q }) => tag !== '' && tag !== '*' && q > 0)
        .sort((a, b) => b.q - a.q || a.order - b.order);
    for (const { tag } of ranges) {
        const locale = toLocale(tag) ?? toLocale(tag.split('-')[0]);
        if (locale !== undefined) {
            return locale;
        }
    }
    return undefined;
}

/** For what the Worker renders itself (emails from D-02 on): user locale, cookie, `Accept-Language`, then English. */
export function resolveRequestLocale(sources: LocaleSources): Locale {
    return (
        toLocale(sources.userLocale) ??
        fromCookie(sources.cookieHeader) ??
        fromAcceptLanguage(sources.acceptLanguage) ??
        baseLocale
    );
}
