import type { Locale } from '../../../paraglide/runtime';
import type { LicenseView } from '../../../shared/api/routes';

/** What the website billing screen links to. Configuration only: nothing here ever comes from a request or a URL. */
export interface WebsiteBillingConfig {
    /** `WEBSITE_ORIGIN`: the https origin that sells licences. */
    readonly websiteOrigin: string;
    /** Where "Buy on ptbk.io" goes, per locale, as a path on `websiteOrigin`. */
    readonly buyPaths: Readonly<Record<Locale, string>>;
    /** The website's invoices page, per locale; null while the website has none, which hides the link. */
    readonly invoicesPaths: Readonly<Record<Locale, string>> | null;
    /** Locales the website writes its plan label in; elsewhere the screen names the plan generically. */
    readonly planLabelLocales: readonly Locale[];
}

/**
 * Production's website and today's answers to #329's open points: the website's pages and plan labels are Czech only,
 * so every locale buys on the Czech subscription page, and there is no invoices page to link yet.
 */
export const DEFAULT_WEBSITE_BILLING_CONFIG: WebsiteBillingConfig = Object.freeze({
    websiteOrigin: 'https://www.ptbk.io',
    buyPaths: Object.freeze({ en: '/cs/pricing/predplatne', cs: '/cs/pricing/predplatne' }),
    invoicesPaths: null,
    planLabelLocales: Object.freeze(['cs'] as const),
});

/** The server's own cap on a manage link (`manageUrlSchema`). */
const MAX_URL_LENGTH = 2048;

function parseUrl(value: string): URL | null {
    if (value.length > MAX_URL_LENGTH) return null;
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

/** A bare https origin, exactly as written: no path, credentials, query, fragment or trailing slash. */
function httpsOrigin(value: string): string | null {
    const url = parseUrl(value);
    return url !== null && url.protocol === 'https:' && url.origin === value ? url.origin : null;
}

function onOrigin(url: URL, origin: string): boolean {
    return url.protocol === 'https:' && url.origin === origin && url.username === '' && url.password === '';
}

/**
 * A page on the website from configuration, or null. The path is appended to the origin, never resolved against it, so
 * a protocol-relative or backslash path stays a path on the website instead of naming another host.
 */
export function websitePageUrl(websiteOrigin: string, path: string): string | null {
    const origin = httpsOrigin(websiteOrigin);
    if (origin === null || !path.startsWith('/')) return null;
    const url = parseUrl(`${origin}${path}`);
    return url !== null && onOrigin(url, origin) ? url.href : null;
}

/**
 * The licence's manage link, checked again before it becomes a link: the server already refused anything but an https
 * page on `WEBSITE_ORIGIN` without credentials, and the SPA is the last step before the browser leaves.
 */
export function trustedManageUrl(manageUrl: string, websiteOrigin: string): string | null {
    const origin = httpsOrigin(websiteOrigin);
    const url = parseUrl(manageUrl);
    return origin !== null && url !== null && onOrigin(url, origin) ? url.href : null;
}

export interface WebsiteBillingLinks {
    /** Without a current licence. */
    readonly buy: string | null;
    /** With a linked account, when it is not the buy page again. */
    readonly manage: string | null;
    /** With a linked account and an invoices page configured. */
    readonly invoices: string | null;
}

const HOLDS_LICENSE: ReadonlySet<LicenseView['status']> = new Set(['active', 'trial', 'scheduled']);

/** The links to ptbk.io for one licence view; each is null when it has nothing to offer or fails the checks above. */
export function websiteBillingLinks(input: {
    readonly config: WebsiteBillingConfig;
    readonly locale: Locale;
    readonly license: Pick<LicenseView, 'link' | 'status' | 'manageUrl'>;
}): WebsiteBillingLinks {
    const { config, locale, license } = input;
    const linked = license.link !== null;
    const buy = HOLDS_LICENSE.has(license.status)
        ? null
        : websitePageUrl(config.websiteOrigin, config.buyPaths[locale]);
    const manage = linked ? trustedManageUrl(license.manageUrl, config.websiteOrigin) : null;
    const invoices =
        linked && config.invoicesPaths !== null
            ? websitePageUrl(config.websiteOrigin, config.invoicesPaths[locale])
            : null;
    return { buy, manage: manage === buy ? null : manage, invoices };
}

/** The website's plan label where it is written in the reader's language; null lets the screen name it generically. */
export function planLabelFor(label: string | null, locale: Locale, config: WebsiteBillingConfig): string | null {
    return config.planLabelLocales.includes(locale) ? label : null;
}
