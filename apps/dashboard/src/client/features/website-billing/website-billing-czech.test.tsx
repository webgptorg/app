import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWebsiteBillingPage, WEBSITE_MANAGE_URL, websiteLicense } from '../../testing/website-billing';
import { DEFAULT_WEBSITE_BILLING_CONFIG } from './website-links';

// Paraglide resolves the first locale once per page load, so the Czech scenario lives in its own test file.
describe('website billing for a Czech browser', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shows the website’s Czech plan label, the state and the links in Czech, addressing the reader formally', async () => {
        renderWebsiteBillingPage(websiteLicense(), {
            ...DEFAULT_WEBSITE_BILLING_CONFIG,
            invoicesPaths: { en: '/en/account/invoices', cs: '/cs/ucet/faktury' },
        });
        expect(await screen.findByText('Business (měsíčně)')).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Fakturace', level: 1 })).toBeTruthy();
        expect(screen.getByText('Aktivní')).toBeTruthy();
        expect(screen.getByText(/^Platí do /)).toBeTruthy();
        expect(screen.getByRole('link', { name: /^Spravovat na ptbk\.io/ }).getAttribute('href')).toBe(
            WEBSITE_MANAGE_URL,
        );
        expect(screen.getByRole('link', { name: /^Faktury na ptbk\.io/ }).getAttribute('href')).toBe(
            'https://www.ptbk.io/cs/ucet/faktury',
        );
        expect(screen.getByText(/Co Vaše licence pokrývají/i)).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Co licence mění', level: 2 })).toBeTruthy();
        expect(screen.getByText(/^Licence jsou informativní\. .*Vaše projekty běží dál/)).toBeTruthy();
    });

    it('offers to buy on the configured Czech page without a licence', async () => {
        renderWebsiteBillingPage(
            websiteLicense({ link: null, state: 'unknown', status: null, label: null, term: null, grants: [] }),
        );
        expect(await screen.findByText('Bez licence')).toBeTruthy();
        expect(screen.getByRole('link', { name: /^Koupit na ptbk\.io/ }).getAttribute('href')).toBe(
            'https://www.ptbk.io/cs/pricing/predplatne',
        );
    });
});
