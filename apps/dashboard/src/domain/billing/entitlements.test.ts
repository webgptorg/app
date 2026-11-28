import { describe, expect, it } from 'vitest';

import type { BillingStatus } from '../../shared/billing';
import { TEST_OFF_PLAN, TEST_PLANS, TEST_PRICE_IDS, testOrgId } from '../../testing/billing-fixtures';
import type { OrgId } from '../ids';
import type { SubscriptionRecord } from './billing-store';
import { createFixedEntitlements, createSubscriptionEntitlements, resolvePlan } from './entitlements';
import {
    createPlanCatalogue,
    createPlanEntitlements,
    planCatalogueSchema,
    planEntitlementsSchema,
} from './plan-catalogue';

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
        expect(await entitlements.limit(starterOrg, 'agents.per-project.max', signal)).toBeNull();
        expect(await entitlements.limit(scaleOrg, 'agents.per-project.max', signal)).toBe(20);
        expect(await entitlements.overLimit(starterOrg, signal)).toBe('block');
        expect(await entitlements.overLimit(scaleOrg, signal)).toBe('warn');
    });

    it('gives an organization without a live subscription the none plan', async () => {
        const canceled = testOrgId();
        const { entitlements } = entitlementsFor([subscription(canceled, 'canceled')]);
        expect(await entitlements.allows(canceled, 'engines.create', signal)).toBe(false);
        expect(await entitlements.limit(canceled, 'engines.max', signal)).toBe(0);
        expect(await entitlements.overLimit(canceled, signal)).toBe('block');
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

describe('createFixedEntitlements (billing off)', () => {
    const entitlements = createFixedEntitlements(createPlanEntitlements(planEntitlementsSchema.parse(TEST_OFF_PLAN)));

    it('grants every organization the same plan, with its limits', async () => {
        for (const orgId of [testOrgId(), testOrgId()]) {
            expect(await entitlements.allows(orgId, 'engines.create', signal)).toBe(true);
            expect(await entitlements.limit(orgId, 'engines.max', signal)).toBe(3);
            expect(await entitlements.limit(orgId, 'custom-domains.max', signal)).toBe(1);
            expect(await entitlements.limit(orgId, 'people.max', signal)).toBe(10);
            expect(await entitlements.limit(orgId, 'agents.max', signal)).toBeNull();
            expect(await entitlements.overLimit(orgId, signal)).toBe('block');
        }
    });

    it('grants nothing the plan leaves out, and keeps unlimited as null', async () => {
        const none = createFixedEntitlements(
            createPlanEntitlements(
                planEntitlementsSchema.parse({
                    features: [],
                    quotas: { 'engines.max': null, 'custom-domains.max': 0 },
                    overLimit: 'warn',
                }),
            ),
        );
        expect(await none.allows(testOrgId(), 'engines.create', signal)).toBe(false);
        expect(await none.limit(testOrgId(), 'engines.max', signal)).toBeNull();
        expect(await none.overLimit(testOrgId(), signal)).toBe('warn');
    });
});
