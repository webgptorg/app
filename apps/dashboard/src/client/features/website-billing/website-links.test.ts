import { describe, expect, it } from 'vitest';

import {
    DEFAULT_WEBSITE_BILLING_CONFIG,
    planLabelFor,
    trustedManageUrl,
    websiteBillingLinks,
    websitePageUrl,
} from './website-links';
import type { WebsiteBillingConfig } from './website-links';

const ORIGIN = 'https://www.ptbk.io';
const MANAGE = 'https://www.ptbk.io/cs/ucet/predplatne';
const LINKED = { linkedAt: 0, linkedByEmail: null };
const WITH_INVOICES: WebsiteBillingConfig = {
    ...DEFAULT_WEBSITE_BILLING_CONFIG,
    buyPaths: { en: '/en/pricing', cs: '/cs/pricing/predplatne' },
    invoicesPaths: { en: '/en/account/invoices', cs: '/cs/ucet/faktury' },
};

describe('website page links', () => {
    it('builds a page on the configured https origin', () => {
        expect(websitePageUrl(ORIGIN, '/cs/pricing/predplatne')).toBe('https://www.ptbk.io/cs/pricing/predplatne');
        expect(websitePageUrl('https://staging.ptbk.io', '/en/pricing?plan=business')).toBe(
            'https://staging.ptbk.io/en/pricing?plan=business',
        );
    });

    it.each([
        ['plain http', 'http://www.ptbk.io'],
        ['a non-web scheme', 'javascript:alert(1)'],
        ['a path on the origin', 'https://www.ptbk.io/cs'],
        ['a trailing slash', 'https://www.ptbk.io/'],
        ['credentials', 'https://user:pass@www.ptbk.io'],
        ['no URL at all', 'www.ptbk.io'],
    ])('refuses an origin with %s', (_case, origin) => {
        expect(websitePageUrl(origin, '/cs/pricing/predplatne')).toBeNull();
    });

    it.each([
        ['a relative path', 'cs/pricing'],
        ['another origin', 'https://evil.example/pricing'],
        ['credentials', '@evil.example/pricing'],
    ])('refuses a path that is %s', (_case, path) => {
        expect(websitePageUrl(ORIGIN, path)).toBeNull();
    });

    it('keeps protocol-relative and backslash paths on the website', () => {
        for (const path of ['//evil.example/x', '/\\evil.example/x']) {
            const url = websitePageUrl(ORIGIN, path);
            expect(url === null ? null : new URL(url).origin).toBe(ORIGIN);
        }
    });
});

describe('the manage link', () => {
    it('passes an https page on the website origin, in any locale', () => {
        expect(trustedManageUrl(MANAGE, ORIGIN)).toBe(MANAGE);
        expect(trustedManageUrl('https://www.ptbk.io/en/account', ORIGIN)).toBe('https://www.ptbk.io/en/account');
    });

    it.each([
        ['a foreign origin', 'https://evil.example/cs/ucet'],
        ['a look-alike host', 'https://www.ptbk.io.evil.example/cs/ucet'],
        ['another subdomain', 'https://shop.ptbk.io/cs/ucet'],
        ['plain http', 'http://www.ptbk.io/cs/ucet'],
        ['a script URL', 'javascript:alert(document.cookie)'],
        ['credentials', 'https://user:secret@www.ptbk.io/cs/ucet'],
        ['an over-long URL', `https://www.ptbk.io/${'a'.repeat(2048)}`],
        ['no URL', '/cs/ucet'],
    ])('refuses %s', (_case, url) => {
        expect(trustedManageUrl(url, ORIGIN)).toBeNull();
    });

    it('refuses everything when the configured origin is not https', () => {
        expect(trustedManageUrl('http://www.ptbk.io/cs/ucet', 'http://www.ptbk.io')).toBeNull();
    });
});

describe('links for a licence', () => {
    it('offers manage and, when configured, invoices to a linked organization with a licence', () => {
        expect(
            websiteBillingLinks({
                config: WITH_INVOICES,
                locale: 'en',
                license: { link: LINKED, status: 'active', manageUrl: MANAGE },
            }),
        ).toEqual({ buy: null, manage: MANAGE, invoices: 'https://www.ptbk.io/en/account/invoices' });
    });

    it.each(['trial', 'scheduled'] as const)('counts a %s licence as held: no buy link', (status) => {
        const links = websiteBillingLinks({
            config: WITH_INVOICES,
            locale: 'cs',
            license: { link: LINKED, status, manageUrl: MANAGE },
        });
        expect(links.buy).toBeNull();
        expect(links.invoices).toBe('https://www.ptbk.io/cs/ucet/faktury');
    });

    it('offers only buy to an organization without a linked account', () => {
        expect(
            websiteBillingLinks({
                config: WITH_INVOICES,
                locale: 'en',
                license: { link: null, status: null, manageUrl: 'https://www.ptbk.io/cs/pricing/predplatne' },
            }),
        ).toEqual({ buy: 'https://www.ptbk.io/en/pricing', manage: null, invoices: null });
    });

    it('offers buy after a licence ended, and manage only when it is not the same page', () => {
        const ended = websiteBillingLinks({
            config: DEFAULT_WEBSITE_BILLING_CONFIG,
            locale: 'en',
            license: { link: LINKED, status: 'expired', manageUrl: MANAGE },
        });
        expect(ended).toEqual({ buy: 'https://www.ptbk.io/cs/pricing/predplatne', manage: MANAGE, invoices: null });
        const none = websiteBillingLinks({
            config: DEFAULT_WEBSITE_BILLING_CONFIG,
            locale: 'cs',
            license: { link: LINKED, status: 'none', manageUrl: 'https://www.ptbk.io/cs/pricing/predplatne' },
        });
        expect(none).toEqual({ buy: 'https://www.ptbk.io/cs/pricing/predplatne', manage: null, invoices: null });
    });

    it('drops a manage link that is not on the website, and every link when the origin is wrong', () => {
        const foreign = websiteBillingLinks({
            config: WITH_INVOICES,
            locale: 'en',
            license: { link: LINKED, status: 'active', manageUrl: 'https://evil.example/manage' },
        });
        expect(foreign.manage).toBeNull();
        expect(
            websiteBillingLinks({
                config: { ...WITH_INVOICES, websiteOrigin: 'http://www.ptbk.io' },
                locale: 'en',
                license: { link: LINKED, status: 'expired', manageUrl: 'http://www.ptbk.io/cs' },
            }),
        ).toEqual({ buy: null, manage: null, invoices: null });
    });
});

describe('the plan label', () => {
    it('shows the website’s label only in the locales it is written in', () => {
        expect(planLabelFor('Business (měsíčně)', 'cs', DEFAULT_WEBSITE_BILLING_CONFIG)).toBe('Business (měsíčně)');
        expect(planLabelFor('Business (měsíčně)', 'en', DEFAULT_WEBSITE_BILLING_CONFIG)).toBeNull();
        expect(
            planLabelFor('Business', 'en', { ...DEFAULT_WEBSITE_BILLING_CONFIG, planLabelLocales: ['en', 'cs'] }),
        ).toBe('Business');
    });
});
