import type { Feature, Quota } from '../../shared/billing';
import type { OrgId } from '../ids';
import { billingState, usesSubscribedPlan } from './billing-state';
import type { BillingStore, SubscriptionRecord } from './billing-store';
import type { Plan, PlanCatalogue } from './plan-catalogue';

export type { Feature, Quota };

/**
 * The only thing the rest of the dashboard asks about billing (ADR 0017): never a plan name, a card or a Stripe
 * object. Computed from the stored subscription on every call, so a webhook changes the answer at once.
 */
export interface Entitlements {
    allows(orgId: OrgId, feature: Feature, signal: AbortSignal): Promise<boolean>;
    /** `null` means unlimited. */
    limit(orgId: OrgId, quota: Quota, signal: AbortSignal): Promise<number | null>;
}

/**
 * The plan a subscription grants: the subscribed one while it is active, trialing or past due, otherwise `none`. A
 * price the catalogue does not know also falls to `none`, the safe default.
 */
export function resolvePlan(catalogue: PlanCatalogue, subscription: SubscriptionRecord | null): Plan {
    if (subscription === null || !usesSubscribedPlan(billingState(subscription))) {
        return catalogue.none;
    }
    return catalogue.byPriceId(subscription.priceId) ?? catalogue.none;
}

export function createSubscriptionEntitlements(deps: {
    readonly store: Pick<BillingStore, 'findSubscription'>;
    readonly catalogue: PlanCatalogue;
}): Entitlements {
    const planOf = async (orgId: OrgId) => resolvePlan(deps.catalogue, await deps.store.findSubscription(orgId));
    return {
        allows: async (orgId, feature) => (await planOf(orgId)).features.includes(feature),
        limit: async (orgId, quota) => (await planOf(orgId)).quotas[quota],
    };
}
