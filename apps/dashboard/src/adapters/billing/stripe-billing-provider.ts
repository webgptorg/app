import Stripe from 'stripe';
import { z } from 'zod';

import { billingStatusFromStripe } from '../../domain/billing/billing-state';
import type { BillingProvider, ProviderSubscription, WebhookVerification } from '../../domain/billing/billing-provider';
import { CHECKOUT_RETURN_PATHS } from '../../shared/billing';

/** Per Stripe API call; there is one retry on network errors, with Stripe's idempotency keys. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The part of the Stripe client the adapter uses. The real `Stripe` instance satisfies it; tests pass a fake, so no
 * test talks to Stripe or needs a key.
 */
export interface StripeApi {
    readonly customers: {
        create(params: Stripe.CustomerCreateParams, options: Stripe.RequestOptions): Promise<{ readonly id: string }>;
    };
    readonly checkout: {
        readonly sessions: {
            create(params: Stripe.Checkout.SessionCreateParams): Promise<{ readonly url: string | null }>;
        };
    };
    readonly billingPortal: {
        readonly sessions: {
            create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ readonly url: string }>;
        };
    };
    readonly subscriptions: { retrieve(id: string): Promise<unknown> };
}

export function createStripeApi(secretKey: string): StripeApi {
    return new Stripe(secretKey, {
        // Workers have fetch, not Node's http.
        httpClient: Stripe.createFetchHttpClient(),
        timeout: REQUEST_TIMEOUT_MS,
        maxNetworkRetries: 1,
        // The SDK otherwise reports request latencies to Stripe in headers; it learns nothing it needs from them.
        telemetry: false,
    });
}

const idOf = z.union([z.string(), z.object({ id: z.string() }).transform((object) => object.id)]);

/** A Stripe subscription, read tolerantly (Stripe's contract) and only for the fields billing stores. */
const subscriptionSchema = z.object({
    id: z.string(),
    customer: idOf,
    status: z.string(),
    cancel_at_period_end: z.boolean(),
    items: z.object({
        data: z
            .array(
                z.object({
                    price: z.object({ id: z.string() }),
                    quantity: z.number().int().nonnegative().nullish(),
                    // Per item since API version 2025-03-31.
                    current_period_end: z.number().int().nonnegative().nullish(),
                }),
            )
            .min(1),
    }),
});

function toProviderSubscription(raw: unknown): ProviderSubscription {
    const subscription = subscriptionSchema.parse(raw);
    // Flat plans have one item; the first one names the plan until the pricing model says otherwise.
    const [item] = subscription.items.data as [(typeof subscription.items.data)[number]];
    return {
        id: subscription.id,
        customerId: subscription.customer,
        status: billingStatusFromStripe(subscription.status),
        priceId: item.price.id,
        quantity: item.quantity ?? null,
        currentPeriodEnd: item.current_period_end == null ? null : item.current_period_end * 1000,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
    };
}

function isNotFound(error: unknown): boolean {
    return error instanceof Stripe.errors.StripeError && error.statusCode === 404;
}

/** The SDK takes no AbortSignal: stop waiting when the request is gone, and let its own timeout end the call. */
async function untilAborted<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
            reject(signal.reason as Error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([call(), aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Stripe behind the {@link BillingProvider} port: Checkout in subscription mode, the customer portal, subscriptions
 * fetched fresh for every webhook. Card data never reaches us; no Stripe.js runs on our pages.
 */
export function createStripeBillingProvider(deps: {
    readonly api: StripeApi;
    readonly dashboardOrigin: string;
    readonly verifyWebhook: (payload: Uint8Array, signature: string) => Promise<WebhookVerification>;
}): BillingProvider {
    const { api, dashboardOrigin } = deps;
    return {
        async createCustomer({ orgId, email }, signal) {
            const customer = await untilAborted(signal, () =>
                api.customers.create(
                    { email, metadata: { org_id: orgId } },
                    // Two first-time requests at once get one customer, not two.
                    { idempotencyKey: `ptbk-org-customer-${orgId}` },
                ),
            );
            return { customerId: customer.id };
        },

        async createCheckoutSession({ orgId, customerId, priceId, trialDays, returnTo }, signal) {
            const returnUrl = `${dashboardOrigin}${CHECKOUT_RETURN_PATHS[returnTo]}`;
            const session = await untilAborted(signal, () =>
                api.checkout.sessions.create({
                    mode: 'subscription',
                    customer: customerId,
                    client_reference_id: orgId,
                    // Quantity stays 1 until the pricing model (per engine, seat or agent) is decided.
                    line_items: [{ price: priceId, quantity: 1 }],
                    subscription_data: {
                        metadata: { org_id: orgId },
                        ...(trialDays === null ? {} : { trial_period_days: trialDays }),
                    },
                    // A trial still takes the card: engines need a paid, verified account (spec, Abuse on our
                    // domains, item 4), and the subscription goes on without a gap when the trial ends.
                    ...(trialDays === null ? {} : { payment_method_collection: 'always' as const }),
                    success_url: `${returnUrl}?checkout=success`,
                    cancel_url: `${returnUrl}?checkout=cancel`,
                }),
            );
            if (session.url === null) {
                throw new Error('Stripe returned a Checkout session without a URL');
            }
            return { url: session.url };
        },

        async createPortalSession({ customerId }, signal) {
            const session = await untilAborted(signal, () =>
                api.billingPortal.sessions.create({ customer: customerId, return_url: `${dashboardOrigin}/billing` }),
            );
            return { url: session.url };
        },

        async getSubscription(subscriptionId, signal) {
            try {
                return toProviderSubscription(
                    await untilAborted(signal, () => api.subscriptions.retrieve(subscriptionId)),
                );
            } catch (error) {
                if (isNotFound(error)) {
                    return null;
                }
                throw error;
            }
        },

        verifyWebhook: deps.verifyWebhook,
    };
}
