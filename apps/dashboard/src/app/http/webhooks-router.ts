import { Hono } from 'hono';
import { z } from 'zod';

import { billingEventSchema } from '../../domain/billing/billing-provider';
import type { BillingService } from '../../domain/billing/billing-service';
import { defineRoute } from '../../shared/api/contract';
import type { RouteBinder } from './bind-route';

export const WEBHOOKS_MOUNT = '/webhooks';

/** Stripe events are small; invoices with many lines are the largest, far below this. */
const WEBHOOK_BODY_BYTES = 512 * 1024;

export const webhookRoutes = {
    /** Signature-verified over the raw body by the route helper; the body schema is the verified event's projection. */
    stripe: defineRoute({
        method: 'POST',
        path: '/webhooks/stripe',
        auth: 'stripe-signature',
        permission: null,
        rateLimit: 'webhook-ip',
        input: {
            params: null,
            query: null,
            headers: z.strictObject({ 'stripe-signature': z.string().min(1).max(4096) }),
            body: billingEventSchema,
            maxBodyBytes: WEBHOOK_BODY_BYTES,
        },
        output: z.strictObject({ received: z.literal(true) }),
        errorCodes: ['invalid-signature'],
    }),
} as const;

/** Signed provider callbacks. Fast and idempotent: write D1 and answer; Stripe retries anything that is not 2xx. */
export function createWebhooksRouter(deps: {
    readonly billing: BillingService | null;
    readonly routes: RouteBinder;
}): Hono {
    const router = new Hono();
    const { billing } = deps;
    // With billing off nothing is mounted: no event is verified, recorded or acknowledged.
    if (billing !== null) {
        deps.routes.bind(router, WEBHOOKS_MOUNT, webhookRoutes.stripe, async ({ input, request }) => {
            await billing.handleEvent(input.body, request.signal);
            return { kind: 'ok', body: { received: true as const } };
        });
    }
    return router;
}
