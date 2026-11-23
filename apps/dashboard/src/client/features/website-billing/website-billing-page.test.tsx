import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWebsiteBillingPage, WEBSITE_MANAGE_URL, websiteLicense } from '../../testing/website-billing';
import { DEFAULT_WEBSITE_BILLING_CONFIG } from './website-links';

const WITH_INVOICES = {
    ...DEFAULT_WEBSITE_BILLING_CONFIG,
    invoicesPaths: { en: '/en/account/invoices', cs: '/cs/ucet/faktury' },
};

function linkHref(name: RegExp): string | null {
    return screen.getByRole('link', { name }).getAttribute('href');
}

describe('website billing page', () => {
    it('shows the licence’s plan, state and term with manage and invoices links to ptbk.io', async () => {
        const page = renderWebsiteBillingPage(websiteLicense(), WITH_INVOICES);
        expect(await screen.findByText('ptbk.io license')).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Billing', level: 1 })).toBeTruthy();
        expect(screen.getByText('Active')).toBeTruthy();
        expect(screen.getByText(/^Valid until /)).toBeTruthy();
        expect(linkHref(/^Manage on ptbk\.io/)).toBe(WEBSITE_MANAGE_URL);
        expect(linkHref(/^Invoices on ptbk\.io/)).toBe('https://www.ptbk.io/en/account/invoices');
        expect(screen.queryByRole('link', { name: /^Buy on ptbk\.io/ })).toBeNull();
        expect(screen.getByRole('heading', { name: 'What a license changes', level: 2 })).toBeTruthy();
        expect(screen.getByText(/^Licenses are advisory\. .*nothing is blocked/)).toBeTruthy();
        await expectNoAxeViolations(page.container);
    });

    it('offers to buy and to link the account when the organization has neither', async () => {
        const page = renderWebsiteBillingPage(
            websiteLicense({
                link: null,
                state: 'unknown',
                status: null,
                label: null,
                term: null,
                checkedAt: null,
                manageUrl: 'https://www.ptbk.io/cs/pricing/predplatne',
                grants: [],
                coverage: null,
                notice: 'unlinked',
            }),
            WITH_INVOICES,
        );
        expect(await screen.findByText('No license')).toBeTruthy();
        expect(linkHref(/^Buy on ptbk\.io/)).toBe('https://www.ptbk.io/cs/pricing/predplatne');
        expect(screen.queryByRole('link', { name: /^Manage on ptbk\.io/ })).toBeNull();
        expect(screen.queryByRole('link', { name: /^Invoices on ptbk\.io/ })).toBeNull();
        await page.user.click(screen.getByRole('button', { name: 'Link your ptbk.io account' }));
        expect(page.navigations).toEqual(['/api/website-access/start']);
    });

    it('offers to buy again after a licence ended, and shows no invoices link until one is configured', async () => {
        renderWebsiteBillingPage(
            websiteLicense({ status: 'expired', term: { kind: 'ended', at: new Date(0).toISOString() } }),
        );
        expect(await screen.findByText('Expired')).toBeTruthy();
        expect(linkHref(/^Buy on ptbk\.io/)).toBe('https://www.ptbk.io/cs/pricing/predplatne');
        expect(linkHref(/^Manage on ptbk\.io/)).toBe(WEBSITE_MANAGE_URL);
        expect(screen.queryByRole('link', { name: /^Invoices/ })).toBeNull();
    });

    it('never links a manage URL off the website, nor falls back to it', async () => {
        renderWebsiteBillingPage(websiteLicense({ manageUrl: 'https://evil.example/manage' }), WITH_INVOICES);
        expect(await screen.findByText('Active')).toBeTruthy();
        expect(screen.queryByRole('link', { name: /^Manage on ptbk\.io/ })).toBeNull();
        expect(screen.getAllByRole('link').map((link) => new URL(link.getAttribute('href') ?? '').origin)).toEqual([
            'https://www.ptbk.io',
        ]);
    });

    it('does not promise that nothing is blocked once the licence is enforced', async () => {
        renderWebsiteBillingPage(websiteLicense({ enforcement: 'enforce' }));
        expect(await screen.findByText('Active')).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'What a license changes' })).toBeNull();
        expect(screen.queryByText(/nothing is blocked/)).toBeNull();
    });

    it('says calmly when ptbk.io did not answer', async () => {
        renderWebsiteBillingPage(websiteLicense({ state: 'stale' }));
        expect(await screen.findByText('ptbk.io didn’t answer just now')).toBeTruthy();
    });
});
