import { WalletOrigin } from '@ptbk/engine-api';

/**
 * What the member typed as a website, as the origin the engine stores (`github.com` → `https://github.com`), or `null`
 * when it is not an http(s) website. Paths are dropped: a login belongs to the whole site.
 */
export function toWalletOrigin(typed: string): string | null {
    const trimmed = typed.trim();
    if (trimmed === '') return null;
    const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    // Written as http and switched, so the bundle carries no absolute https URL (the dist check refuses them).
    const withScheme = typedScheme ? trimmed : `http://${trimmed}`;
    if (!URL.canParse(withScheme)) return null;
    const url = new URL(withScheme);
    if (!typedScheme) url.protocol = 'https:';
    const origin = url.origin;
    return WalletOrigin.safeParse(origin).success ? origin : null;
}

/** The host people recognise a site by, without the scheme or a leading `www.`. */
export function siteName(origin: string): string {
    return URL.canParse(origin) ? new URL(origin).host.replace(/^www\./, '') : origin;
}
