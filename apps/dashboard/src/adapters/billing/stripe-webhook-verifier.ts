import Stripe from 'stripe';
import { z } from 'zod';

import { billingEventSchema, type BillingEvent, type WebhookVerification } from '../../domain/billing/billing-provider';
import type { Clock } from '../../domain/ports/clock';

/** Stripe's own recommendation, and what the D-07 brief fixes: a signed timestamp older than 5 minutes is a replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const objectIdSchema = z.union([z.string(), z.object({ id: z.string() }).transform((object) => object.id)]);

/**
 * Stripe's event envelope, read tolerantly: it is Stripe's contract, not ours, and new fields must not fail delivery.
 * Only the event ID, its type and the subscription it concerns are kept; the state is fetched again from Stripe.
 */
const stripeEventSchema = z.object({
    id: z.string(),
    type: z.string(),
    data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

const invoiceSchema = z.object({
    // API versions from 2025-03-31 put the subscription here; older webhook endpoints still send `subscription`.
    parent: z
        .object({ subscription_details: z.object({ subscription: objectIdSchema.nullish() }).nullish() })
        .nullish(),
    subscription: objectIdSchema.nullish(),
});

const checkoutSessionSchema = z.object({ subscription: objectIdSchema.nullish() });

function subscriptionOf(type: string, object: Readonly<Record<string, unknown>>): string | null {
    if (type.startsWith('customer.subscription.')) {
        return z.string().parse(object['id']);
    }
    if (type.startsWith('checkout.session.')) {
        return checkoutSessionSchema.parse(object).subscription ?? null;
    }
    if (type.startsWith('invoice.')) {
        const invoice = invoiceSchema.parse(object);
        return invoice.parent?.subscription_details?.subscription ?? invoice.subscription ?? null;
    }
    return null;
}

function project(event: unknown): BillingEvent | null {
    try {
        const envelope = stripeEventSchema.parse(event);
        const projected = billingEventSchema.safeParse({
            id: envelope.id,
            type: envelope.type,
            subscriptionId: subscriptionOf(envelope.type, envelope.data.object),
        });
        return projected.success ? projected.data : null;
    } catch {
        return null;
    }
}

/**
 * Stripe's signature scheme (HMAC-SHA-256 over `t.payload`, with a timestamp tolerance) through the official package,
 * on WebCrypto because the synchronous variant needs Node's crypto. The signature is checked over the exact bytes
 * received; Stripe parses the JSON only afterwards.
 */
export function createStripeWebhookVerifier(deps: {
    readonly secret: string;
    readonly clock: Clock;
}): (payload: Uint8Array, signature: string) => Promise<WebhookVerification> {
    const cryptoProvider = Stripe.createSubtleCryptoProvider();
    return async (payload, signature) => {
        let event: unknown;
        try {
            event = await Stripe.webhooks.constructEventAsync(
                payload,
                signature,
                deps.secret,
                WEBHOOK_TOLERANCE_SECONDS,
                cryptoProvider,
                deps.clock.nowMs(),
            );
        } catch {
            return { kind: 'invalid' };
        }
        const projected = project(event);
        return projected === null ? { kind: 'invalid' } : { kind: 'verified', event: projected };
    };
}

/** Without a webhook secret nothing verifies: the dev fake without `STRIPE_WEBHOOK_SECRET` refuses every webhook. */
export function rejectAllWebhooks(): Promise<WebhookVerification> {
    return Promise.resolve({ kind: 'invalid' });
}
