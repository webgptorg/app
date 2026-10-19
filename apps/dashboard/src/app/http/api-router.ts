import { Hono } from 'hono';

import { apiRoutes } from '../../shared/api/routes';
import type { DashboardConfig } from '../config';
import { bindRoute } from './bind-route';

export const API_MOUNT = '/api';

/** The SPA's own API. Session authentication arrives with D-02; every handler then authorizes on its own. */
export function createApiRouter(deps: { readonly config: DashboardConfig }): Hono {
    const router = new Hono();
    bindRoute(router, API_MOUNT, apiRoutes.getEnvironment, () =>
        Promise.resolve({ kind: 'ok', body: { environment: deps.config.environment } }),
    );
    return router;
}
