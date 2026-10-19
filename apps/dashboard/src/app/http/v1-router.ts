import { Hono } from 'hono';
import { z } from 'zod';

import type { DashboardConfig } from '../config';

export const V1_MOUNT = '/v1';

export const healthResponseSchema = z.strictObject({
    ok: z.literal(true),
    environment: z.enum(['dev', 'staging', 'production']),
});

/** Machine API for engines. Cookies are ignored here; registration (D-03) and heartbeat (D-05) bind protocol contracts. */
export function createV1Router(deps: { readonly config: DashboardConfig }): Hono {
    const router = new Hono();
    router.get('/health', (context) =>
        context.json(healthResponseSchema.parse({ ok: true, environment: deps.config.environment })),
    );
    return router;
}
