import { Hono } from 'hono';

export const WEBHOOKS_MOUNT = '/webhooks';

/** Signed provider callbacks, Stripe first (D-07). */
export function createWebhooksRouter(): Hono {
    return new Hono();
}
