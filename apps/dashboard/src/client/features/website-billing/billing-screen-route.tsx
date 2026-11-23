import type { SessionView } from '../../../shared/api/routes';
import { BillingPage } from '../billing/billing-page';
import type { CheckoutReturn } from '../billing/billing-page';
import { requireBilling, requireLicensing } from '../session/session-guards';
import { WebsiteBillingPage } from './website-billing-page';

/** What `/billing` renders: ptbk.io's licence and links, or the dashboard's own Checkout. */
export type BillingScreen = 'website' | 'checkout';

/**
 * `beforeLoad` of `/billing` once it renders the website screen: with billing `website` it needs `license.read`, as
 * `/license` does; otherwise it is the Checkout, not found with billing off. The session cannot tell the fake Checkout
 * from Stripe and needn't: config refuses the fake adapter outside dev.
 */
export function requireBillingScreen(session: SessionView): BillingScreen {
    if (session.licensing) {
        requireLicensing(session);
        return 'website';
    }
    requireBilling(session);
    return 'checkout';
}

/** The page {@link requireBillingScreen} chose. */
export function BillingScreenPage(props: {
    readonly screen: BillingScreen;
    readonly checkout: CheckoutReturn | undefined;
}) {
    switch (props.screen) {
        case 'website':
            return <WebsiteBillingPage />;
        case 'checkout':
            return <BillingPage checkout={props.checkout} />;
    }
}
