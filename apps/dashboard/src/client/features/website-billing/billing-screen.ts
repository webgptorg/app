import type { SessionView } from '../../../shared/api/routes';
import type { BillingAdapter } from '../../../shared/billing';
import type { Environment } from '../../../shared/environment';

/** What `/billing` renders: ptbk.io's licence and links, the dashboard's own Checkout, or nothing (not found). */
export type BillingScreen = 'website' | 'checkout' | 'none';

export interface BillingSetup {
    readonly billing: BillingAdapter;
    readonly environment: Environment;
}

/**
 * The fake Checkout subscribes without paying, so it exists only in dev. Config already refuses the fake adapter in
 * staging and production; the SPA refuses it there too rather than trust one layer.
 */
export function isFakeCheckoutAllowed(setup: BillingSetup): boolean {
    return setup.billing === 'fake' && setup.environment === 'dev';
}

export function selectBillingScreen(setup: BillingSetup): BillingScreen {
    switch (setup.billing) {
        case 'website':
            return 'website';
        case 'stripe':
            return 'checkout';
        case 'fake':
            return isFakeCheckoutAllowed(setup) ? 'checkout' : 'none';
        case 'off':
            return 'none';
    }
}

/**
 * The adapter as the SPA can tell it from today's session. The session does not tell Stripe from the fake: in dev a
 * Checkout is taken for the fake one, elsewhere for Stripe, which config guarantees. Once the session names its adapter,
 * read that instead and drop this.
 */
export function billingAdapterOf(
    session: Pick<SessionView, 'billingEnabled' | 'licensing'>,
    environment: Environment,
): BillingAdapter {
    if (session.licensing) return 'website';
    if (!session.billingEnabled) return 'off';
    return environment === 'dev' ? 'fake' : 'stripe';
}
