import type { BillingStatus } from '../../shared/billing';

/** The organization's billing state as the rest of billing reasons about it; adapters map provider objects into it. */
export type BillingState =
    | { readonly kind: 'none' }
    | {
          readonly kind: Exclude<BillingStatus, 'none'>;
          /** Milliseconds since the Unix epoch; null when the provider did not say. */
          readonly currentPeriodEnd: number | null;
      };

/**
 * Stripe's subscription status as a {@link BillingStatus}. Anything that is not a paying, trialing or dunning
 * subscription (`incomplete`, `incomplete_expired`, `paused`, and statuses Stripe adds later) maps to `none`, so an
 * unknown state can never grant more than an organization without a subscription has.
 */
export function billingStatusFromStripe(status: string): BillingStatus {
    switch (status) {
        case 'active':
        case 'trialing':
        case 'past_due':
        case 'unpaid':
        case 'canceled':
            return status;
        default:
            return 'none';
    }
}

/** Statuses whose subscribed plan applies. `past_due` keeps it: there is no automatic downgrade, as there is no automatic suspension. */
const PLAN_STATUSES: readonly BillingStatus[] = ['active', 'trialing', 'past_due'];

/** Statuses of a subscription that still exists at the provider; a new Checkout would create a second one. */
export const OPEN_STATUSES: readonly BillingStatus[] = [...PLAN_STATUSES, 'unpaid'];

export function usesSubscribedPlan(state: BillingState): boolean {
    return PLAN_STATUSES.includes(state.kind);
}

export function isOpenSubscription(status: BillingStatus): boolean {
    return OPEN_STATUSES.includes(status);
}

export function billingState(
    subscription: { readonly status: BillingStatus; readonly currentPeriodEnd: number | null } | null,
): BillingState {
    if (subscription === null || subscription.status === 'none') {
        return { kind: 'none' };
    }
    return { kind: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd };
}
