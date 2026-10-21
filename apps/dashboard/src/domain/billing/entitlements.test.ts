import { describe, expect, it } from 'vitest';

import type { BillingStatus } from '../../shared/billing';
import { TEST_PLANS, TEST_PRICE_IDS, testOrgId } from '../../testing/billing-fixtures';
import type { OrgId } from '../ids';
import type { SubscriptionRecord } from './billing-store';
import { createSubscriptionEntitlements, resolvePlan } from './entitlements';
import { createPlanCatalogue, planCatalogueSchema } from './plan-catalogue';

const catalogue = createPlanCatalogue(planCatalogueSchema.parse(TEST_PLANS));
const signal = new AbortController().signal;

function subscription(
    orgId: OrgId,
    status: BillingStatus,
    priceId: string = TEST_PRICE_IDS.starter,
): SubscriptionRecord {
    return {
        orgId,
        subscriptionId: 'sub_1',
        status,
        priceId,
        quantity: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        updatedAt: 0,
    };
}

function entitlementsFor(rows: readonly SubscriptionRecord[]) {
    const reads: OrgId[] = [];
    const entitlements = createSubscriptionEntitlements({
        catalogue,
        store: {
            findSubscription: (orgId) => {
                reads.push(orgId);
                return Promise.resolve(rows.find((row) => row.orgId === orgId) ?? null);
            },
        },
    });
    return { entitlements, reads };
}

describe('resolvePlan', () => {
    const orgId = testOrgId();

    it.each<[BillingStatus, string]>([
        ['active', 'starter'],
        ['trialing', 'starter'],
        ['past_due', 'starter'],
        ['unpaid', 'none'],
        ['canceled', 'none'],
        ['none', 'none'],
    ])('a %s subscription resolves to the %s plan', (status, planId) => {
        expect(resolvePlan(catalogue, subscription(orgId, status)).id).toBe(planId);
    });

    it('falls to none without a subscription and for a price the catalogue does not know', () => {
        expect(resolvePlan(catalogue, null).id).toBe('none');
        expect(resolvePlan(catalogue, subscription(orgId, 'active', 'price_retired')).id).toBe('none');
    });
});

describe('SubscriptionEntitlements', () => {
    it('answers with the plan’s features and quotas, null meaning unlimited', async () => {
        const starterOrg = testOrgId();
        const scaleOrg = testOrgId();
        const { entitlements } = entitlementsFor([
            subscription(starterOrg, 'active'),
            subscription(scaleOrg, 'trialing', TEST_PRICE_IDS.scale),
        ]);
        expect(await entitlements.allows(starterOrg, 'engines.create', signal)).toBe(true);
        expect(await entitlements.limit(starterOrg, 'engines.max', signal)).toBe(2);
        expect(await entitlements.limit(starterOrg, 'custom-domains.max', signal)).toBe(0);
        expect(await entitlements.limit(scaleOrg, 'engines.max', signal)).toBeNull();
        expect(await entitlements.limit(scaleOrg, 'custom-domains.max', signal)).toBe(5);
    });

    it('gives an organization without a live subscription the none plan', async () => {
        const canceled = testOrgId();
        const { entitlements } = entitlementsFor([subscription(canceled, 'canceled')]);
        expect(await entitlements.allows(canceled, 'engines.create', signal)).toBe(false);
        expect(await entitlements.limit(canceled, 'engines.max', signal)).toBe(0);
    });

    it('reads only the asked organization’s subscription', async () => {
        const orgA = testOrgId();
        const orgB = testOrgId();
        const { entitlements, reads } = entitlementsFor([subscription(orgA, 'active')]);
        expect(await entitlements.allows(orgB, 'engines.create', signal)).toBe(false);
        expect(await entitlements.allows(orgA, 'engines.create', signal)).toBe(true);
        expect(reads).toEqual([orgB, orgA]);
    });
});
