import { createFileRoute, redirect } from '@tanstack/react-router';

import { billingQuery } from '../../api/queries';
import { BillingPage } from '../../features/billing/billing-page';
import { requireBilling } from '../../features/session/session-guards';
import type { CheckoutReturn } from '../../features/billing/billing-page';

interface BillingSearch {
    /** Set by the Checkout success and cancel URLs (D-07); anything else is dropped. */
    readonly checkout?: CheckoutReturn;
}

function checkoutReturn(value: unknown): CheckoutReturn | undefined {
    return value === 'success' || value === 'cancel' ? value : undefined;
}

export const Route = createFileRoute('/_app/billing')({
    validateSearch: (search: Readonly<Record<string, unknown>>): BillingSearch => {
        const checkout = checkoutReturn(search['checkout']);
        return checkout === undefined ? {} : { checkout };
    },
    beforeLoad: ({ context }) => {
        // Billing became License with the website's licences (ADR 0021); old links and bookmarks follow it.
        if (context.session.licensing) {
            throw redirect({ to: '/license', replace: true });
        }
        requireBilling(context.session);
    },
    // Prefetch only, failures swallowed: the page shows its own loading and error state.
    loader: ({ context }) => {
        void context.queryClient.query(billingQuery(context.apiClient)).catch(() => undefined);
    },
    component: function Billing() {
        return <BillingPage checkout={checkoutReturn(Route.useSearch().checkout)} />;
    },
});
