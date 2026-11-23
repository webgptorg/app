import { describe, expect, it } from 'vitest';

import { BILLING_ADAPTERS } from '../../../shared/billing';
import { environmentSchema } from '../../../shared/environment';
import { billingAdapterOf, isFakeCheckoutAllowed, selectBillingScreen } from './billing-screen';

const ENVIRONMENTS = environmentSchema.options;

describe('the billing screen', () => {
    it.each(ENVIRONMENTS)('follows the adapter in %s', (environment) => {
        expect(selectBillingScreen({ billing: 'website', environment })).toBe('website');
        expect(selectBillingScreen({ billing: 'stripe', environment })).toBe('checkout');
        expect(selectBillingScreen({ billing: 'off', environment })).toBe('none');
    });

    it('shows the fake Checkout in dev only', () => {
        expect(selectBillingScreen({ billing: 'fake', environment: 'dev' })).toBe('checkout');
        expect(selectBillingScreen({ billing: 'fake', environment: 'staging' })).toBe('none');
        expect(selectBillingScreen({ billing: 'fake', environment: 'production' })).toBe('none');
    });

    it('allows the fake Checkout for the fake adapter in dev and nothing else', () => {
        const allowed = BILLING_ADAPTERS.flatMap((billing) =>
            ENVIRONMENTS.filter((environment) => isFakeCheckoutAllowed({ billing, environment })).map(
                (environment) => `${billing}/${environment}`,
            ),
        );
        expect(allowed).toEqual(['fake/dev']);
    });
});

describe('the adapter the session implies', () => {
    it('reads website and off from the session’s flags in every environment', () => {
        for (const environment of ENVIRONMENTS) {
            expect(billingAdapterOf({ licensing: true, billingEnabled: false }, environment)).toBe('website');
            expect(billingAdapterOf({ licensing: false, billingEnabled: false }, environment)).toBe('off');
        }
    });

    it('takes a Checkout for the fake one in dev and for Stripe elsewhere, so it is never fake outside dev', () => {
        const checkout = { licensing: false, billingEnabled: true };
        expect(billingAdapterOf(checkout, 'dev')).toBe('fake');
        expect(billingAdapterOf(checkout, 'staging')).toBe('stripe');
        expect(billingAdapterOf(checkout, 'production')).toBe('stripe');
    });
});
