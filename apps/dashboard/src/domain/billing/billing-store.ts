import type { BillingStatus } from '../../shared/billing';
import type { OrgId } from '../ids';
import { isOpenSubscription } from './billing-state';

/**
 * The organization's subscription as last fetched from the provider. Account and organization metadata only: no card
 * details, billing addresses or invoice contents (Stripe is the system of record).
 */
export interface SubscriptionRecord {
    readonly orgId: OrgId;
    readonly subscriptionId: string;
    readonly status: BillingStatus;
    readonly priceId: string;
    readonly quantity: number | null;
    readonly currentPeriodEnd: number | null;
    readonly cancelAtPeriodEnd: boolean;
    /** When the state was fetched from the provider; an older fetch never overwrites a newer one. */
    readonly updatedAt: number;
}

export interface ProblemOrganizationRecord {
    readonly orgId: OrgId;
    readonly kind: 'personal' | 'team';
    readonly name: string | null;
    readonly status: 'past_due' | 'unpaid' | 'canceled';
    readonly currentPeriodEnd: number | null;
    readonly updatedAt: number;
}

export interface ProviderEventRecord {
    readonly eventId: string;
    readonly type: string;
    readonly receivedAt: number;
}

/** Billing state in D1. Every organization-owned read and write takes the `orgId`. */
export interface BillingStore {
    findCustomer(orgId: OrgId): Promise<string | null>;
    /** Keeps an existing mapping (a concurrent request may have won) and returns the organization's customer. */
    saveCustomer(orgId: OrgId, customerId: string, now: number): Promise<string>;
    /** Webhooks only: which organization a provider customer belongs to. */
    findOrgByCustomer(customerId: string): Promise<OrgId | null>;
    findSubscription(orgId: OrgId): Promise<SubscriptionRecord | null>;
    hasEvent(eventId: string): Promise<boolean>;
    /**
     * Atomically records a handled event and, when given, stores the subscription under {@link shouldReplace}: the
     * same subscription only by a fetch at least as new, and another one only if it is open or the stored one is over.
     */
    recordEvent(event: ProviderEventRecord, subscription: SubscriptionRecord | null): Promise<void>;
    /** Forgets events received before `before`; Stripe stops retrying an event after three days. */
    pruneEvents(before: number): Promise<void>;
    listProblemOrganizations(): Promise<readonly ProblemOrganizationRecord[]>;
}

/**
 * Whether `incoming` may overwrite the organization's stored subscription. The same subscription only with a fetch at
 * least as new, so a slow handler cannot write back older state. Another subscription only if it is open or the stored
 * one is over, so a late event about a canceled subscription never hides the one that replaced it.
 */
export function shouldReplace(existing: SubscriptionRecord | null, incoming: SubscriptionRecord): boolean {
    if (existing === null) {
        return true;
    }
    if (existing.subscriptionId === incoming.subscriptionId) {
        return incoming.updatedAt >= existing.updatedAt;
    }
    return isOpenSubscription(incoming.status) || !isOpenSubscription(existing.status);
}
