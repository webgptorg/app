import { Hono } from 'hono';
import { z } from 'zod';

import { defineRoute, NO_INPUT } from '../../shared/api/contract';
import { environmentSchema } from '../../shared/environment';
import type { DashboardConfig } from '../config';
import type { RouteBinder } from './bind-route';

export const V1_MOUNT = '/v1';

export const healthRoute = defineRoute({
    method: 'GET',
    path: '/v1/health',
    auth: 'public',
    permission: null,
    rateLimit: 'public-read-ip',
    input: NO_INPUT,
    output: z.strictObject({ ok: z.literal(true), environment: environmentSchema }),
    errorCodes: [],
});

/** Machine API for engines. Cookies are ignored here; registration (D-03) and heartbeat (D-05) bind protocol contracts. */
export function createV1Router(deps: { readonly config: DashboardConfig; readonly routes: RouteBinder }): Hono {
    const router = new Hono();
    deps.routes.bind(router, V1_MOUNT, healthRoute, () =>
        Promise.resolve({ kind: 'ok', body: { ok: true, environment: deps.config.environment } }),
    );
    return router;
}
