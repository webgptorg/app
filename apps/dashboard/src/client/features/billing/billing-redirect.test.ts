import { describe, expect, it } from 'vitest';

import { isAllowedRedirect } from './billing-redirect';

const ORIGIN = 'https://app.ptbk.test';

describe('isAllowedRedirect', () => {
    it('allows https anywhere and the page origin', () => {
        expect(isAllowedRedirect('https://checkout.stripe.com/c/pay/x', ORIGIN)).toBe(true);
        expect(isAllowedRedirect('http://localhost:5173/billing', 'http://localhost:5173')).toBe(true);
    });

    it('refuses other schemes, foreign plain http and garbage', () => {
        expect(isAllowedRedirect('http://evil.example/', ORIGIN)).toBe(false);
        expect(isAllowedRedirect('javascript:alert(1)', ORIGIN)).toBe(false);
        expect(isAllowedRedirect('data:text/html,x', ORIGIN)).toBe(false);
        expect(isAllowedRedirect('/billing', ORIGIN)).toBe(false);
    });
});
