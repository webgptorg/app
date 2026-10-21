import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { syntheticStripeKey, testOrgId } from '../../testing/billing-fixtures';
import { createStripeApi, createStripeBillingProvider, type StripeApi } from './stripe-billing-provider';
import { rejectAllWebhooks } from './stripe-webhook-verifier';

const ORIGIN = 'https://app.ptbk.test';
const signal = new AbortController().signal;

interface Calls {
    readonly customers: unknown[];
    readonly checkouts: unknown[];
    readonly portals: unknown[];
    readonly retrieved: string[];
}

function fakeStripe(
    overrides: { readonly subscription?: () => Promise<unknown>; readonly checkoutUrl?: string | null } = {},
) {
    const calls: Calls = { customers: [], checkouts: [], portals: [], retrieved: [] };
    const api: StripeApi = {
        customers: {
            create: (params, options) => {
                calls.customers.push({ params, options });
                return Promise.resolve({ id: 'cus_1' });
            },
        },
        checkout: {
            sessions: {
                create: (params) => {
                    calls.checkouts.push(params);
                    return Promise.resolve({
                        url:
                            overrides.checkoutUrl === undefined
                                ? 'https://checkout.stripe.com/c/pay/cs_1'
                                : overrides.checkoutUrl,
                    });
                },
            },
        },
        billingPortal: {
            sessions: {
                create: (params) => {
                    calls.portals.push(params);
                    return Promise.resolve({ url: 'https://billing.stripe.com/p/session/1' });
                },
            },
        },
        subscriptions: {
            retrieve: (id) => {
                calls.retrieved.push(id);
                return overrides.subscription?.() ?? Promise.resolve(subscription());
            },
        },
    };
    return {
        api,
        calls,
        provider: createStripeBillingProvider({ api, dashboardOrigin: ORIGIN, verifyWebhook: rejectAllWebhooks }),
    };
}

function subscription(overrides: Record<string, unknown> = {}, item: Record<string, unknown> = {}) {
    return {
        id: 'sub_1',
        object: 'subscription',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: false,
        default_payment_method: 'pm_never_stored',
        items: {
            object: 'list',
            data: [
                {
                    id: 'si_1',
                    price: { id: 'price_1', unit_amount: 1 },
                    quantity: 3,
                    current_period_end: 1_900_000_000,
                    ...item,
                },
            ],
        },
        ...overrides,
    };
}

describe('Stripe billing provider', () => {
    it('creates the organization’s customer with its email and the org ID as the only metadata, idempotently', async () => {
        const { provider, calls } = fakeStripe();
        const orgId = testOrgId();
        expect(await provider.createCustomer({ orgId, email: 'owner@example.test' }, signal)).toEqual({
            customerId: 'cus_1',
        });
        expect(calls.customers).toEqual([
            {
                params: { email: 'owner@example.test', metadata: { org_id: orgId } },
                options: { idempotencyKey: `ptbk-org-customer-${orgId}` },
            },
        ]);
    });

    it('opens Checkout in subscription mode for the price, returning to /billing', async () => {
        const { provider, calls } = fakeStripe();
        const orgId = testOrgId();
        expect(
            await provider.createCheckoutSession({ orgId, customerId: 'cus_1', priceId: 'price_1' }, signal),
        ).toEqual({
            url: 'https://checkout.stripe.com/c/pay/cs_1',
        });
        expect(calls.checkouts).toEqual([
            {
                mode: 'subscription',
                customer: 'cus_1',
                client_reference_id: orgId,
                line_items: [{ price: 'price_1', quantity: 1 }],
                subscription_data: { metadata: { org_id: orgId } },
                success_url: `${ORIGIN}/billing?checkout=success`,
                cancel_url: `${ORIGIN}/billing?checkout=cancel`,
            },
        ]);
    });

    it('fails loudly on a Checkout session without a URL', async () => {
        const { provider } = fakeStripe({ checkoutUrl: null });
        await expect(
            provider.createCheckoutSession({ orgId: testOrgId(), customerId: 'cus_1', priceId: 'price_1' }, signal),
        ).rejects.toThrow('without a URL');
    });

    it('opens the customer portal returning to /billing', async () => {
        const { provider, calls } = fakeStripe();
        expect(await provider.createPortalSession({ customerId: 'cus_1' }, signal)).toEqual({
            url: 'https://billing.stripe.com/p/session/1',
        });
        expect(calls.portals).toEqual([{ customer: 'cus_1', return_url: `${ORIGIN}/billing` }]);
    });

    it('fetches a subscription and keeps only what billing stores, in milliseconds', async () => {
        const { provider, calls } = fakeStripe();
        expect(await provider.getSubscription('sub_1', signal)).toEqual({
            id: 'sub_1',
            customerId: 'cus_1',
            status: 'active',
            priceId: 'price_1',
            quantity: 3,
            currentPeriodEnd: 1_900_000_000_000,
            cancelAtPeriodEnd: false,
        });
        expect(calls.retrieved).toEqual(['sub_1']);
    });

    it('reads expanded customers, missing quantities and period ends, and maps unknown statuses to none', async () => {
        const { provider } = fakeStripe({
            subscription: () =>
                Promise.resolve(
                    subscription(
                        {
                            customer: { id: 'cus_2', object: 'customer' },
                            status: 'incomplete_expired',
                            cancel_at_period_end: true,
                        },
                        { quantity: null, current_period_end: undefined },
                    ),
                ),
        });
        expect(await provider.getSubscription('sub_1', signal)).toEqual({
            id: 'sub_1',
            customerId: 'cus_2',
            status: 'none',
            priceId: 'price_1',
            quantity: null,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: true,
        });
    });

    it('answers null for a subscription Stripe does not know and rethrows every other failure', async () => {
        const missing = new Stripe.errors.StripeInvalidRequestError({
            message: 'No such subscription',
            type: 'invalid_request_error',
            statusCode: 404,
        });
        expect(
            await fakeStripe({ subscription: () => Promise.reject(missing) }).provider.getSubscription('sub_x', signal),
        ).toBeNull();
        const outage = new Stripe.errors.StripeAPIError({ message: 'down', type: 'api_error', statusCode: 500 });
        await expect(
            fakeStripe({ subscription: () => Promise.reject(outage) }).provider.getSubscription('sub_x', signal),
        ).rejects.toBe(outage);
        await expect(
            fakeStripe({ subscription: () => Promise.resolve({ id: 'sub_1' }) }).provider.getSubscription(
                'sub_x',
                signal,
            ),
        ).rejects.toThrow();
    });

    it('stops waiting when the request is aborted', async () => {
        const aborted = AbortSignal.abort(new Error('client went away'));
        const { provider, calls } = fakeStripe();
        await expect(provider.createPortalSession({ customerId: 'cus_1' }, aborted)).rejects.toThrow(
            'client went away',
        );
        expect(calls.portals).toEqual([]);
        const controller = new AbortController();
        const hanging = fakeStripe({ subscription: () => new Promise(() => undefined) });
        const pending = hanging.provider.getSubscription('sub_1', controller.signal);
        controller.abort(new Error('timed out'));
        await expect(pending).rejects.toThrow('timed out');
    });

    it('builds a real client on fetch without calling Stripe', () => {
        const api = createStripeApi(syntheticStripeKey());
        expect(api).toBeInstanceOf(Stripe);
        expect(typeof api.subscriptions.retrieve).toBe('function');
    });
});
