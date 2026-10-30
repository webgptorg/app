import { describe, expect, it } from 'vitest';

import { planNameText, planPriceText, quotaValue } from './billing-labels';

const formatCurrency = (amount: string, currency: string) => `${amount} ${currency}`;

describe('plan labels', () => {
    it('names a plan in the current locale, and the none plan from the catalogues', () => {
        const name = { en: 'Standard', cs: 'Standardní' };
        expect(planNameText(name, 'en')).toBe('Standard');
        expect(planNameText(name, 'cs')).toBe('Standardní');
        expect(planNameText(null, 'en')).toBe('No plan');
    });

    it('states the price per interval, or that Stripe shows it', () => {
        expect(planPriceText({ amount: '29', currency: 'EUR', interval: 'month' }, formatCurrency)).toBe(
            '29 EUR per month',
        );
        expect(planPriceText({ amount: '290', currency: 'EUR', interval: 'year' }, formatCurrency)).toBe(
            '290 EUR per year',
        );
        expect(planPriceText(null, formatCurrency)).toBe('Price shown on Stripe before you pay');
    });

    it('says a quota of 0 is not included unless something still uses it', () => {
        expect(quotaValue(0, null)).toBe('Not included');
        expect(quotaValue(0, 0)).toBe('Not included');
        expect(quotaValue(0, 2)).toBe('2 of 0');
        expect(quotaValue(5, null)).toBe('5');
        expect(quotaValue(5, 2)).toBe('2 of 5');
        expect(quotaValue(null, null)).toBe('Unlimited');
        expect(quotaValue(null, 1)).toBe('1 of unlimited');
    });
});
