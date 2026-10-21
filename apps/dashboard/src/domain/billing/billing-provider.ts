import { z } from 'zod';

import type { BillingStatus } from '../../shared/billing';
import type { OrgId } from '../ids';

/** A subscription as the provider holds it now, already mapped to our vocabulary by the adapter. */
export interface ProviderSubscription {
    readonly id: string;
    readonly customerId: string;
    readonly status: BillingStatus;
    readonly priceId: string;
    readonly quantity: number | null;
    /** Milliseconds since the Unix epoch. */
    readonly currentPeriodEnd: number | null;
    readonly cancelAtPeriodEnd: boolean;
}

/**
 * What the dashboard needs from a verified webhook: which event (for idempotency), its type and the subscription it
 * concerns. The state itself is always fetched again, so an event delivered late or out of order cannot apply stale
 * data.
 */
export const billingEventSchema = z.strictObject({
    id: z.string().regex(/^evt_[A-Za-z0-9_]{1,255}$/),
    type: z.string().regex(/^[a-z0-9_.]{1,128}$/),
    subscriptionId: z
        .string()
        .regex(/^sub_[A-Za-z0-9_]{1,255}$/)
        .nullable(),
});
export type BillingEvent = z.infer<typeof billingEventSchema>;

export type WebhookVerification =
    { readonly kind: 'verified'; readonly event: BillingEvent } | { readonly kind: 'invalid' };

/**
 * The payment provider (Stripe). Only `src/domain/billing/` and the composition root know it exists; the rest of the
 * dashboard asks `Entitlements` (test/billing-boundaries.test.ts).
 */
export interface BillingProvider {
    /** The customer is the organization's: metadata carries the `org_id` and nothing else. */
    createCustomer(
        input: { readonly orgId: OrgId; readonly email: string },
        signal: AbortSignal,
    ): Promise<{ readonly customerId: string }>;
    createCheckoutSession(
        input: { readonly orgId: OrgId; readonly customerId: string; readonly priceId: string },
        signal: AbortSignal,
    ): Promise<{ readonly url: string }>;
    createPortalSession(input: { readonly customerId: string }, signal: AbortSignal): Promise<{ readonly url: string }>;
    /** Null when the provider does not know the subscription. */
    getSubscription(subscriptionId: string, signal: AbortSignal): Promise<ProviderSubscription | null>;
    /** Verifies the signature over the exact bytes received, then reads the event; nothing is parsed before. */
    verifyWebhook(payload: Uint8Array, signature: string): Promise<WebhookVerification>;
}
