import type { OrganizationRecord } from '../domain/auth/records';
import {
    shouldReplace,
    type BillingStore,
    type ProblemOrganizationRecord,
    type ProviderEventRecord,
    type SubscriptionRecord,
} from '../domain/billing/billing-store';
import type { OrgId } from '../domain/ids';
import { PROBLEM_STATUSES } from '../shared/billing';

export interface MemoryBillingState {
    readonly customers: Map<string, { readonly customerId: string; readonly createdAt: number }>;
    readonly subscriptions: Map<string, SubscriptionRecord>;
    readonly events: Map<string, ProviderEventRecord>;
}

function isProblem(status: string): status is ProblemOrganizationRecord['status'] {
    return (PROBLEM_STATUSES as readonly string[]).includes(status);
}

/**
 * The {@link BillingStore} in memory, for tests: the shared suite in `billing-store-contract.ts` holds it to the same
 * contract as the D1 adapter. Organizations come from the auth store it sits next to.
 */
export function createMemoryBillingStore(deps: {
    readonly org: (orgId: OrgId) => OrganizationRecord | undefined;
}): BillingStore & { readonly state: MemoryBillingState } {
    const state: MemoryBillingState = { customers: new Map(), subscriptions: new Map(), events: new Map() };
    const missingOrg = (orgId: OrgId) =>
        deps.org(orgId) === undefined ? Promise.reject(new Error('FOREIGN KEY constraint failed')) : null;
    return {
        state,
        findCustomer: (orgId) => Promise.resolve(state.customers.get(orgId)?.customerId ?? null),
        saveCustomer(orgId, customerId, now) {
            const missing = missingOrg(orgId);
            if (missing !== null) {
                return missing;
            }
            const existing = state.customers.get(orgId);
            if (existing !== undefined) {
                return Promise.resolve(existing.customerId);
            }
            if ([...state.customers.values()].some((customer) => customer.customerId === customerId)) {
                return Promise.reject(new Error('UNIQUE constraint failed: billing_customers.stripe_customer_id'));
            }
            state.customers.set(orgId, { customerId, createdAt: now });
            return Promise.resolve(customerId);
        },
        findOrgByCustomer(customerId) {
            const entry = [...state.customers].find(([, customer]) => customer.customerId === customerId);
            return Promise.resolve(entry === undefined ? null : (entry[0] as OrgId));
        },
        findSubscription: (orgId) => Promise.resolve(state.subscriptions.get(orgId) ?? null),
        hasEvent: (eventId) => Promise.resolve(state.events.has(eventId)),
        recordEvent(event, subscription) {
            if (subscription !== null) {
                const missing = missingOrg(subscription.orgId);
                if (missing !== null) {
                    return missing;
                }
                if (shouldReplace(state.subscriptions.get(subscription.orgId) ?? null, subscription)) {
                    state.subscriptions.set(subscription.orgId, subscription);
                }
            }
            if (!state.events.has(event.eventId)) {
                state.events.set(event.eventId, event);
            }
            return Promise.resolve();
        },
        pruneEvents(before) {
            for (const [eventId, event] of state.events) {
                if (event.receivedAt < before) {
                    state.events.delete(eventId);
                }
            }
            return Promise.resolve();
        },
        listProblemOrganizations() {
            const rows = [...state.subscriptions.values()].flatMap((subscription): ProblemOrganizationRecord[] => {
                const org = deps.org(subscription.orgId);
                return org === undefined || !isProblem(subscription.status)
                    ? []
                    : [
                          {
                              orgId: subscription.orgId,
                              kind: org.kind,
                              name: org.name,
                              status: subscription.status,
                              currentPeriodEnd: subscription.currentPeriodEnd,
                              updatedAt: subscription.updatedAt,
                          },
                      ];
            });
            rows.sort((a, b) => b.updatedAt - a.updatedAt || a.orgId.localeCompare(b.orgId));
            return Promise.resolve(rows);
        },
    };
}
