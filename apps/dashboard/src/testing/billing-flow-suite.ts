import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orgIdSchema } from '../domain/ids';
import type { BillingView, ProblemOrganization, SessionView } from '../shared/api/routes';
import type { BillingStatus } from '../shared/billing';
import type { AuthHarness, TestBrowser } from './auth-harness';
import { ORIGIN } from './auth-harness';
import { problemCode, signUp } from './auth-flows';
import { syntheticWebhookSecret, TEST_PRICE_IDS } from './billing-fixtures';
import { stripeEvent } from './stripe-signature';

const MINUTE = 60_000;

async function billingOf(browser: TestBrowser): Promise<BillingView> {
    const response = await browser.request('GET', '/api/billing');
    expect(response.status).toBe(200);
    return response.body as BillingView;
}

async function orgOf(browser: TestBrowser) {
    const response = await browser.request('GET', '/api/session');
    return orgIdSchema.parse((response.body as SessionView).activeOrg.id);
}

/**
 * The D-07 acceptance tests over HTTP with the fake provider and Stripe's real webhook verification, run against the
 * in-memory stores (unit project) and against D1 (workers project). `makeAdmin` grants the platform admin role the way
 * `scripts/make-admin.md` does on that store.
 */
export function describeBillingFlows(
    name: string,
    makeHarness: () => AuthHarness,
    makeAdmin: (harness: AuthHarness, email: string) => Promise<void>,
): void {
    describe(name, () => {
        let harness: AuthHarness;

        beforeEach(() => {
            harness = makeHarness();
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        async function subscribedOwner(planId = 'starter') {
            const browser = harness.browser();
            const { email } = await signUp(harness, browser);
            const checkout = await browser.request('POST', '/api/billing/checkout', { planId });
            expect(checkout.status).toBe(200);
            const orgId = await orgOf(browser);
            const subscription = [...harness.billingProvider.subscriptions.values()].at(-1);
            if (subscription === undefined) {
                throw new Error('Checkout created no subscription');
            }
            return { browser, email, orgId, subscriptionId: subscription.id };
        }

        /** What Stripe would now return for the subscription; the webhook handler fetches it fresh. */
        function stripeChanges(subscriptionId: string, status: BillingStatus) {
            const current = harness.billingProvider.subscriptions.get(subscriptionId);
            if (current === undefined) {
                throw new Error('unknown subscription');
            }
            harness.billingProvider.subscriptions.set(subscriptionId, { ...current, status });
        }

        function subscriptionEvent(id: string, type: string, subscriptionId: string) {
            return stripeEvent({ id, type, object: { id: subscriptionId, object: 'subscription' } });
        }

        it('takes a new organization to active through the fake Checkout without any network access', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            const browser = harness.browser();
            await signUp(harness, browser);
            const orgId = await orgOf(browser);
            const before = await billingOf(browser);
            expect(before).toMatchObject({
                status: 'none',
                planId: 'none',
                planName: null,
                hasBillingAccount: false,
                canSubscribe: true,
                entitlements: { features: [] },
            });
            expect(before.plans.map(({ id, name, price }) => ({ id, name, price }))).toEqual([
                {
                    id: 'starter',
                    name: { en: 'Starter', cs: 'Začátek' },
                    price: { amount: '12', currency: 'EUR', interval: 'month' },
                },
                { id: 'scale', name: { en: 'Scale', cs: 'Růst' }, price: null },
            ]);
            expect(await harness.deps.entitlements.allows(orgId, 'engines.create', new AbortController().signal)).toBe(
                false,
            );

            const checkout = await browser.request('POST', '/api/billing/checkout', { planId: 'starter' });
            expect(checkout.body).toEqual({ url: `${ORIGIN}/billing?checkout=success` });
            const after = await billingOf(browser);
            expect(after).toMatchObject({
                status: 'active',
                planId: 'starter',
                planName: { en: 'Starter', cs: 'Začátek' },
                hasBillingAccount: true,
                canSubscribe: false,
                cancelAtPeriodEnd: false,
                entitlements: {
                    features: ['engines.create'],
                    quotas: [
                        { quota: 'engines.max', limit: 2, used: null },
                        { quota: 'custom-domains.max', limit: 0, used: null },
                    ],
                },
            });
            expect(after.currentPeriodEnd).toBeGreaterThan(harness.clock.nowMs());
            const signal = new AbortController().signal;
            expect(await harness.deps.entitlements.allows(orgId, 'engines.create', signal)).toBe(true);
            expect(await harness.deps.entitlements.limit(orgId, 'engines.max', signal)).toBe(2);
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('opens the customer portal for the organization’s own customer', async () => {
            const { browser, orgId } = await subscribedOwner();
            const portal = await browser.request('POST', '/api/billing/portal');
            expect(portal.body).toEqual({ url: `${ORIGIN}/billing` });
            const customerId = await harness.billingStore.findCustomer(orgId);
            expect(harness.billingProvider.portals).toEqual([{ customerId }]);
        });

        it('refuses an unknown plan with 400, a second subscription with 409, and any field but planId', async () => {
            const browser = harness.browser();
            await signUp(harness, browser);
            const unknown = await browser.request('POST', '/api/billing/checkout', { planId: 'enterprise' });
            expect([unknown.status, problemCode(unknown)]).toEqual([400, 'unknown-plan']);
            const none = await browser.request('POST', '/api/billing/checkout', { planId: 'none' });
            expect([none.status, problemCode(none)]).toEqual([400, 'unknown-plan']);
            const smuggled = await browser.request('POST', '/api/billing/checkout', {
                planId: 'starter',
                priceId: TEST_PRICE_IDS.scale,
            });
            expect([smuggled.status, problemCode(smuggled)]).toEqual([400, 'invalid-request']);
            expect((await browser.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(200);
            const again = await browser.request('POST', '/api/billing/checkout', { planId: 'scale' });
            expect([again.status, problemCode(again)]).toEqual([409, 'already-subscribed']);
            expect(harness.billingProvider.checkouts).toHaveLength(1);
        });

        it('requires a session for every billing endpoint', async () => {
            const browser = harness.browser();
            expect((await browser.request('GET', '/api/billing')).status).toBe(401);
            expect((await browser.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(401);
            expect((await browser.request('POST', '/api/billing/portal')).status).toBe(401);
            expect((await browser.request('GET', '/api/admin/billing')).status).toBe(401);
        });

        describe('org scoping', () => {
            it('shows each organization only its own billing, and keys the Stripe customer by organization', async () => {
                const a = await subscribedOwner();
                const b = harness.browser();
                await signUp(harness, b);
                const orgB = await orgOf(b);
                expect(await billingOf(b)).toMatchObject({ status: 'none', hasBillingAccount: false });

                expect((await b.request('POST', '/api/billing/portal')).status).toBe(200);
                const customerA = await harness.billingStore.findCustomer(a.orgId);
                const customerB = await harness.billingStore.findCustomer(orgB);
                expect(customerB).not.toBeNull();
                expect(customerB).not.toBe(customerA);
                expect(harness.billingProvider.portals).toEqual([{ customerId: customerB }]);
                expect(harness.billingProvider.customers.get(customerA ?? '')).toEqual({
                    orgId: a.orgId,
                    email: a.email,
                });
                expect(await billingOf(a.browser)).toMatchObject({ status: 'active' });
            });

            it('takes no organization from the request', async () => {
                const a = await subscribedOwner();
                const b = harness.browser();
                await signUp(harness, b);
                // The portal takes no body at all, so a smuggled orgId is never read.
                expect((await b.request('POST', '/api/billing/portal', { orgId: a.orgId })).status).toBe(200);
                const customerB = await harness.billingStore.findCustomer(await orgOf(b));
                expect(harness.billingProvider.portals).toEqual([{ customerId: customerB }]);
                const checkout = await b.request('POST', '/api/billing/checkout', {
                    planId: 'starter',
                    orgId: a.orgId,
                });
                expect([checkout.status, problemCode(checkout)]).toEqual([400, 'invalid-request']);
                const ignored = await b.request('GET', `/api/billing?orgId=${a.orgId}`);
                expect(ignored.body).toMatchObject({ status: 'none', hasBillingAccount: true });
                expect(harness.billingProvider.checkouts).toHaveLength(1);
            });
        });

        describe('trials (D-10)', () => {
            it('starts a trial from the link page, which may then issue link codes, and offers no second one', async () => {
                const browser = harness.browser();
                await signUp(harness, browser);
                const before = await billingOf(browser);
                expect(before.trialAvailable).toBe(true);
                expect(before.plans.map(({ id, trialDays }) => ({ id, trialDays }))).toEqual([
                    { id: 'starter', trialDays: null },
                    { id: 'scale', trialDays: 14 },
                ]);
                const checkout = await browser.request('POST', '/api/billing/checkout', {
                    planId: 'scale',
                    returnTo: 'engines-new',
                });
                expect(checkout.body).toEqual({ url: `${ORIGIN}/engines/new?checkout=success` });
                expect(harness.billingProvider.checkouts.map((entry) => entry.trialDays)).toEqual([14]);
                const trialing = await billingOf(browser);
                expect(trialing).toMatchObject({ status: 'trialing', planId: 'scale', trialAvailable: false });
                expect(trialing.currentPeriodEnd).toBe(harness.clock.nowMs() + 14 * 24 * 60 * MINUTE);
                expect((await browser.request('POST', '/api/engines/link-codes')).status).toBe(200);

                const subscription = [...harness.billingProvider.subscriptions.values()].at(-1);
                stripeChanges(subscription?.id ?? '', 'canceled');
                harness.clock.advance(MINUTE);
                expect(
                    (
                        await harness.webhook(
                            subscriptionEvent('evt_trialover', 'customer.subscription.deleted', subscription?.id ?? ''),
                        )
                    ).status,
                ).toBe(200);
                expect((await browser.request('POST', '/api/billing/checkout', { planId: 'scale' })).status).toBe(200);
                expect(harness.billingProvider.checkouts.map((entry) => entry.trialDays)).toEqual([14, null]);
                expect(await billingOf(browser)).toMatchObject({ status: 'active', trialAvailable: false });
            });

            it('records the trial from a signed customer.subscription webhook', async () => {
                const { browser, orgId, subscriptionId } = await subscribedOwner();
                expect(await harness.billingStore.findTrialStartedAt(orgId)).toBeNull();
                stripeChanges(subscriptionId, 'trialing');
                harness.clock.advance(MINUTE);
                const response = await harness.webhook(
                    subscriptionEvent('evt_trialing', 'customer.subscription.updated', subscriptionId),
                );
                expect(response.status).toBe(200);
                expect(await harness.billingStore.findTrialStartedAt(orgId)).toBe(harness.clock.nowMs());
                expect(await billingOf(browser)).toMatchObject({ status: 'trialing', trialAvailable: false });
            });

            it('returns only to an allowlisted page, never to a given URL', async () => {
                const browser = harness.browser();
                await signUp(harness, browser);
                for (const returnTo of ['https://evil.example/', '/engines/new', 'dashboard']) {
                    const response = await browser.request('POST', '/api/billing/checkout', {
                        planId: 'starter',
                        returnTo,
                    });
                    expect([response.status, problemCode(response)]).toEqual([400, 'invalid-request']);
                }
                const billing = await browser.request('POST', '/api/billing/checkout', {
                    planId: 'starter',
                    returnTo: 'billing',
                });
                expect(billing.body).toEqual({ url: `${ORIGIN}/billing?checkout=success` });
            });
        });

        describe('webhooks', () => {
            it('updates the state on a valid signature, keeping the plan while past due', async () => {
                const { browser, orgId, subscriptionId } = await subscribedOwner();
                stripeChanges(subscriptionId, 'past_due');
                harness.clock.advance(MINUTE);
                const response = await harness.webhook(
                    subscriptionEvent('evt_pastdue', 'customer.subscription.updated', subscriptionId),
                );
                expect([response.status, response.body]).toEqual([200, { received: true }]);
                expect(await billingOf(browser)).toMatchObject({ status: 'past_due', planId: 'starter' });
                expect(
                    await harness.deps.entitlements.allows(orgId, 'engines.create', new AbortController().signal),
                ).toBe(true);
            });

            it('reads the subscription of invoice events from Stripe again', async () => {
                const { browser, subscriptionId } = await subscribedOwner();
                stripeChanges(subscriptionId, 'unpaid');
                harness.clock.advance(MINUTE);
                const payload = stripeEvent({
                    id: 'evt_invoicefailed',
                    type: 'invoice.payment_failed',
                    object: { parent: { subscription_details: { subscription: subscriptionId } } },
                });
                expect((await harness.webhook(payload)).status).toBe(200);
                expect(await billingOf(browser)).toMatchObject({
                    status: 'unpaid',
                    planId: 'none',
                    canSubscribe: false,
                });
            });

            it('rejects a bad signature with 400 and changes nothing', async () => {
                const { browser, subscriptionId } = await subscribedOwner();
                stripeChanges(subscriptionId, 'canceled');
                const payload = subscriptionEvent('evt_forged', 'customer.subscription.deleted', subscriptionId);
                const forged = await harness.webhook(payload, { secret: syntheticWebhookSecret() });
                expect([forged.status, problemCode(forged)]).toEqual([400, 'invalid-signature']);
                const unsigned = await harness.webhook(payload, { signature: '' });
                expect(unsigned.status).toBe(400);
                expect(await billingOf(browser)).toMatchObject({ status: 'active' });
                expect(await harness.billingStore.hasEvent('evt_forged')).toBe(false);
            });

            it('rejects a signature timestamp older than five minutes with 400', async () => {
                const { browser, subscriptionId } = await subscribedOwner();
                stripeChanges(subscriptionId, 'canceled');
                const payload = subscriptionEvent('evt_replayed', 'customer.subscription.deleted', subscriptionId);
                const stale = await harness.webhook(payload, { signedAtMs: harness.clock.nowMs() - 5 * MINUTE - 1000 });
                expect([stale.status, problemCode(stale)]).toEqual([400, 'invalid-signature']);
                expect(await billingOf(browser)).toMatchObject({ status: 'active' });
            });

            it('processes the same event only once', async () => {
                const { browser, subscriptionId } = await subscribedOwner();
                const payload = subscriptionEvent('evt_twice', 'customer.subscription.updated', subscriptionId);
                stripeChanges(subscriptionId, 'past_due');
                harness.clock.advance(MINUTE);
                expect((await harness.webhook(payload)).status).toBe(200);
                stripeChanges(subscriptionId, 'canceled');
                harness.clock.advance(MINUTE);
                expect((await harness.webhook(payload)).status).toBe(200);
                expect(await billingOf(browser)).toMatchObject({ status: 'past_due' });
            });

            it('acknowledges an unknown event type with 200 and changes nothing', async () => {
                const { browser, subscriptionId } = await subscribedOwner();
                stripeChanges(subscriptionId, 'canceled');
                const payload = subscriptionEvent('evt_paused', 'customer.subscription.paused', subscriptionId);
                expect((await harness.webhook(payload)).status).toBe(200);
                expect(await billingOf(browser)).toMatchObject({ status: 'active' });
                expect(await harness.billingStore.hasEvent('evt_paused')).toBe(false);
            });

            it('takes a deleted subscription to canceled and the organization to the none plan', async () => {
                const { browser, orgId, subscriptionId } = await subscribedOwner();
                stripeChanges(subscriptionId, 'canceled');
                harness.clock.advance(MINUTE);
                const payload = subscriptionEvent('evt_deleted', 'customer.subscription.deleted', subscriptionId);
                expect((await harness.webhook(payload)).status).toBe(200);
                expect(await billingOf(browser)).toMatchObject({
                    status: 'canceled',
                    planId: 'none',
                    canSubscribe: true,
                    hasBillingAccount: true,
                    entitlements: { features: [] },
                });
                expect(await harness.deps.entitlements.limit(orgId, 'engines.max', new AbortController().signal)).toBe(
                    0,
                );
            });

            it('never logs a payload, only event IDs and types', async () => {
                const { subscriptionId } = await subscribedOwner();
                const payload = subscriptionEvent('evt_logged', 'customer.subscription.updated', subscriptionId);
                expect((await harness.webhook(payload)).status).toBe(200);
                const webhookLogs = harness.logger.entries.filter((entry) => entry.event.startsWith('billing.'));
                expect(webhookLogs.length).toBeGreaterThan(0);
                for (const entry of webhookLogs) {
                    expect(Object.keys(entry.fields).sort()).toEqual(['eventId', 'type']);
                }
                expect(JSON.stringify(harness.logger.entries)).not.toContain(subscriptionId);
            });
        });

        describe('/api/admin/billing', () => {
            it('is denied to anyone who is not a platform admin', async () => {
                const { browser } = await subscribedOwner();
                const response = await browser.request('GET', '/api/admin/billing');
                expect([response.status, problemCode(response)]).toEqual([403, 'forbidden']);
            });

            it('lists only organizations that are past due, unpaid or canceled', async () => {
                const healthy = await subscribedOwner();
                const late = await subscribedOwner();
                const gone = await subscribedOwner();
                const owners = [healthy, late, gone];
                const trial = harness.browser();
                await signUp(harness, trial);
                stripeChanges(late.subscriptionId, 'past_due');
                stripeChanges(gone.subscriptionId, 'canceled');
                harness.clock.advance(MINUTE);
                for (const [index, owner] of [late, gone].entries()) {
                    const payload = subscriptionEvent(
                        `evt_admin${String(index)}`,
                        'customer.subscription.updated',
                        owner.subscriptionId,
                    );
                    expect((await harness.webhook(payload)).status).toBe(200);
                }

                const admin = harness.browser();
                const { email } = await signUp(harness, admin);
                await makeAdmin(harness, email);
                const response = await admin.request('GET', '/api/admin/billing');
                expect(response.status).toBe(200);
                const listed = (response.body as { organizations: ProblemOrganization[] }).organizations;
                const ours = new Set(owners.map((owner) => owner.orgId as string));
                expect(
                    listed
                        .filter((row) => ours.has(row.orgId))
                        .map((row) => [row.orgId, row.status])
                        .sort(),
                ).toEqual(
                    [
                        [late.orgId, 'past_due'],
                        [gone.orgId, 'canceled'],
                    ].sort(),
                );
                expect(listed.some((row) => row.orgId === healthy.orgId)).toBe(false);
                expect(listed.every((row) => ['past_due', 'unpaid', 'canceled'].includes(row.status))).toBe(true);
            });
        });
    });
}
