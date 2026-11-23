import { notFound } from '@tanstack/react-router';

import type { SessionView } from '../../../shared/api/routes';
import type { Environment } from '../../../shared/environment';
import { environmentQuery } from '../../api/queries';
import type { RouterContext } from '../../core/router-context';
import { BillingPage } from '../billing/billing-page';
import type { CheckoutReturn } from '../billing/billing-page';
import { requireLicensing } from '../session/session-guards';
import { billingAdapterOf, selectBillingScreen } from './billing-screen';
import type { BillingScreen } from './billing-screen';
import { WebsiteBillingPage } from './website-billing-page';

export type ShownBillingScreen = Exclude<BillingScreen, 'none'>;

/**
 * `beforeLoad` of `/billing` once it follows {@link selectBillingScreen}: `none` is not found, as with billing off
 * today, and the website screen needs `license.read`, as `/license` does. An environment that does not load counts as
 * production, so a failed request can never reveal the fake Checkout.
 */
export async function requireBillingScreen(
    context: RouterContext & { readonly session: SessionView },
): Promise<ShownBillingScreen> {
    const environment: Environment = await context.queryClient.query(environmentQuery(context.apiClient)).then(
        (answer) => answer.environment,
        () => 'production',
    );
    const screen = selectBillingScreen({ billing: billingAdapterOf(context.session, environment), environment });
    switch (screen) {
        case 'none':
            throw notFound();
        case 'website':
            requireLicensing(context.session);
            return screen;
        case 'checkout':
            return screen;
    }
}

/** The page {@link requireBillingScreen} chose. */
export function BillingScreenPage(props: {
    readonly screen: ShownBillingScreen;
    readonly checkout: CheckoutReturn | undefined;
}) {
    switch (props.screen) {
        case 'website':
            return <WebsiteBillingPage />;
        case 'checkout':
            return <BillingPage checkout={props.checkout} />;
    }
}
