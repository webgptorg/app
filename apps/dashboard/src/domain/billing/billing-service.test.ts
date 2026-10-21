import { beforeEach, describe, expect, it } from 'vitest';

import { TEST_PLANS, TEST_PRICE_IDS, testOrgId } from '../../testing/billing-fixtures';
import { createTestBilling, type TestBilling } from '../../testing/test-billing';
import { createMemoryBillingStore } from '../../testing/memory-billing-store';
import type { BillingStatus } from '../../shared/billing';
import type { OrgId } from '../ids';
import { EVENT_RETENTION_MS } from './billing-service';
import { createPlanCatalogue, planCatalogueSchema } from './plan-catalogue';

const START = 1_800_000_000_000;
const signal = new AbortController().signal;
const catalogue = createPlanCatalogue(planCatalogueSchema.parse(TEST_PLANS));

interface Logged {
    readonly event: string;
    readonly fields: unknown;
}

describe('BillingService', () => {
    let now: number;
    let logged: Logged[];
    let test: TestBilling;
    let orgId: OrgId;

    beforeEach(() => {
        now = START;
        logged = [];
        const log = (event: string, fields?: unknown) => {
            logged.push({ event, fields });
        };
        test = createTestBilling({
            clock: { nowMs: () => now },
            catalogue,
            dashboardOrigin: 'https://app.ptbk.test',
            store: createMemoryBillingStore({ org: (id) => ({ id, kind: 'team', name: 'Acme', createdAt: 0 }) }),
            logger: { info: log, warn: log, error: log },
        });
        orgId = testOrgId();
    });

    /** What Stripe now says about the organization's only subscription; returns its ID. */
    function stripeChanges(status: BillingStatus): string {
        const [subscription] = test.provider.subscriptions.values();
        if (subscription === undefined) {
            throw new Error('no subscription');
        }
        test.provider.subscriptions.set(subscription.id, { ...subscription, status });
        return subscription.id;
    }

    const checkout = (planId: string, org = orgId) =>
        test.billing.checkout({ orgId: org, email: 'owner@example.test', planId }, signal);

    it('describes an organization without billing: the none plan, and Checkout offered', async () => {
        expect(await test.billing.overview(orgId)).toEqual({
            status: 'none',
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            plan: catalogue.none,
            hasBillingAccount: false,
            canSubscribe: true,
            features: [],
            quotas: [
                { quota: 'engines.max', limit: 0, used: null },
                { quota: 'custom-domains.max', limit: 0, used: null },
            ],
            plans: catalogue.plans,
        });
    });

    it('subscribes through Checkout: one customer per organization, keyed by the organization', async () => {
        expect(await checkout('starter')).toEqual({
            kind: 'ok',
            url: 'https://app.ptbk.test/billing?checkout=success',
        });
        const [customerId, customer] = [...test.provider.customers][0] ?? [];
        expect(customer).toEqual({ orgId, email: 'owner@example.test' });
        expect(test.provider.checkouts).toEqual([{ orgId, customerId, priceId: TEST_PRICE_IDS.starter }]);
        const overview = await test.billing.overview(orgId);
        expect(overview).toMatchObject({
            status: 'active',
            currentPeriodEnd: START + 30 * 86_400_000,
            hasBillingAccount: true,
            canSubscribe: false,
            features: ['engines.create'],
        });
        expect(overview.plan.id).toBe('starter');
        await test.billing.portal({ orgId, email: 'someone-else@example.test' }, signal);
        expect(test.provider.customers.size).toBe(1);
        expect(test.provider.portals).toEqual([{ customerId }]);
    });

    it('refuses an unknown plan, including none, before creating anything', async () => {
        expect(await checkout('enterprise')).toEqual({ kind: 'unknown-plan' });
        expect(await checkout('none')).toEqual({ kind: 'unknown-plan' });
        expect(test.provider.customers.size).toBe(0);
    });

    it.each(['active', 'trialing', 'past_due', 'unpaid'] as const)(
        'refuses a second subscription while one is %s',
        async (status) => {
            await checkout('starter');
            const subscriptionId = stripeChanges(status);
            await test.billing.handleEvent(
                {
                    id: `evt_${status}`,
                    type: 'customer.subscription.updated',
                    subscriptionId,
                },
                signal,
            );
            expect(await checkout('scale')).toEqual({ kind: 'already-subscribed' });
        },
    );

    it('lets an organization subscribe again once the subscription is canceled', async () => {
        await checkout('starter');
        const subscriptionId = stripeChanges('canceled');
        now += 1;
        await test.billing.handleEvent(
            { id: 'evt_deleted', type: 'customer.subscription.deleted', subscriptionId },
            signal,
        );
        expect((await test.billing.overview(orgId)).canSubscribe).toBe(true);
        expect(await checkout('scale')).toMatchObject({ kind: 'ok' });
        expect((await test.billing.overview(orgId)).plan.id).toBe('scale');
    });

    describe('events', () => {
        it('acknowledges and ignores a type it does not handle, without recording it', async () => {
            const event = { id: 'evt_other', type: 'charge.succeeded', subscriptionId: null };
            expect(await test.billing.handleEvent(event, signal)).toBe('ignored');
            expect(await test.store.hasEvent('evt_other')).toBe(false);
            expect(logged).toEqual([
                { event: 'billing.webhook.ignored', fields: { eventId: 'evt_other', type: 'charge.succeeded' } },
            ]);
        });

        it('processes an event once and skips its redelivery', async () => {
            const event = { id: 'evt_once', type: 'invoice.paid', subscriptionId: null };
            expect(await test.billing.handleEvent(event, signal)).toBe('processed');
            expect(await test.billing.handleEvent(event, signal)).toBe('duplicate');
            expect(logged.map((entry) => entry.event)).toEqual([
                'billing.webhook.processed',
                'billing.webhook.duplicate',
            ]);
        });

        it('records but changes nothing for a subscription the provider does not know', async () => {
            const event = { id: 'evt_gone', type: 'customer.subscription.updated', subscriptionId: 'sub_gone' };
            expect(await test.billing.handleEvent(event, signal)).toBe('processed');
            expect(await test.store.hasEvent('evt_gone')).toBe(true);
            expect(logged[0]).toEqual({
                event: 'billing.webhook.unknown-subscription',
                fields: { eventId: 'evt_gone', type: 'customer.subscription.updated' },
            });
        });

        it('changes nothing for a customer that is not ours', async () => {
            test.provider.subscriptions.set('sub_foreign', {
                id: 'sub_foreign',
                customerId: 'cus_foreign',
                status: 'active',
                priceId: TEST_PRICE_IDS.scale,
                quantity: 1,
                currentPeriodEnd: null,
                cancelAtPeriodEnd: false,
            });
            const event = { id: 'evt_foreign', type: 'customer.subscription.created', subscriptionId: 'sub_foreign' };
            expect(await test.billing.handleEvent(event, signal)).toBe('processed');
            expect(await test.billing.problemOrganizations()).toEqual([]);
            expect(logged[0]?.event).toBe('billing.webhook.unknown-customer');
        });

        it('forgets event IDs after the retention period', async () => {
            await test.billing.handleEvent({ id: 'evt_old', type: 'invoice.paid', subscriptionId: null }, signal);
            now += EVENT_RETENTION_MS + 1;
            await test.billing.handleEvent({ id: 'evt_new', type: 'invoice.paid', subscriptionId: null }, signal);
            expect(await test.store.hasEvent('evt_old')).toBe(false);
            expect(await test.store.hasEvent('evt_new')).toBe(true);
        });

        it('logs event IDs and types only', async () => {
            await checkout('starter');
            for (const entry of logged) {
                expect(Object.keys(entry.fields as object).sort()).toEqual(['eventId', 'type']);
            }
        });
    });

    it('lists organizations in a problem state for platform admins', async () => {
        await checkout('starter');
        const subscriptionId = stripeChanges('past_due');
        now += 1;
        await test.billing.handleEvent({ id: 'evt_failed', type: 'invoice.payment_failed', subscriptionId }, signal);
        expect(await test.billing.problemOrganizations()).toEqual([
            {
                orgId,
                kind: 'team',
                name: 'Acme',
                status: 'past_due',
                currentPeriodEnd: START + 30 * 86_400_000,
                updatedAt: START + 1,
            },
        ]);
        const overview = await test.billing.overview(orgId);
        expect(overview.status).toBe('past_due');
        expect(overview.plan.id).toBe('starter');
    });

    it('verifies webhooks through the provider', async () => {
        expect(await test.billing.verifyWebhook(new TextEncoder().encode('{}'), 't=1,v1=00')).toEqual({
            kind: 'invalid',
        });
    });
});
