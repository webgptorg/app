import { isNotFound } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import type { SessionView } from '../../../shared/api/routes';
import { session } from '../../testing/fixtures';
import { requireBillingScreen } from './billing-screen-route';

const LICENSE_READER = ['org.read', 'license.read'];

function notFoundThrown(sessionView: SessionView): boolean {
    try {
        requireBillingScreen(sessionView);
        return false;
    } catch (error) {
        return isNotFound(error);
    }
}

describe('the billing route’s guard', () => {
    it('shows ptbk.io’s screen to whoever may read the licence', () => {
        expect(
            requireBillingScreen(session({ licensing: true, billingEnabled: false, permissions: LICENSE_READER })),
        ).toBe('website');
    });

    it('answers not found for the website screen without license.read, as /license does', () => {
        expect(notFoundThrown(session({ licensing: true, billingEnabled: false }))).toBe(true);
    });

    it('answers not found with billing off', () => {
        expect(notFoundThrown(session({ billingEnabled: false }))).toBe(true);
    });

    it('keeps the Checkout with Stripe or the fake', () => {
        expect(requireBillingScreen(session())).toBe('checkout');
    });
});
