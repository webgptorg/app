import { Hono } from 'hono';

import { apiRoutes } from '../../shared/api/routes';
import type { EngineCreationPolicy } from '../../domain/registration/engine-creation-policy';
import type { DashboardDeps } from '../deps';
import { renderEmail } from '../i18n/render-email';
import { bindAdminHostnameRoutes } from './admin-hostname-routes';
import { bindAuthRoutes } from './auth-routes';
import { bindBillingRoutes } from './billing-routes';
import { bindEngineRoutes } from './engine-routes';
import type { RouteBinder } from './bind-route';
import { crossSiteRequestGuard } from './csrf';

export const API_MOUNT = '/api';

/** The SPA's own API: every state change must come from the dashboard's own pages. */
export function createApiRouter(
    deps: DashboardDeps & { readonly policy: EngineCreationPolicy; readonly routes: RouteBinder },
): Hono {
    const router = new Hono();
    router.use('*', crossSiteRequestGuard(deps.config.dashboardOrigin));
    deps.routes.bind(router, API_MOUNT, apiRoutes.getEnvironment, () =>
        Promise.resolve({ kind: 'ok', body: { environment: deps.config.environment } }),
    );
    bindAuthRoutes(router, API_MOUNT, deps);
    bindBillingRoutes(router, API_MOUNT, deps);
    bindEngineRoutes(router, API_MOUNT, deps);
    bindAdminHostnameRoutes(router, API_MOUNT, deps);
    const { devOutbox } = deps;
    // Not mounted at all otherwise: the fake adapter, and with it this route, exists only in dev (config.ts).
    if (devOutbox !== null && deps.config.adapters.email === 'fake') {
        deps.routes.bind(router, API_MOUNT, apiRoutes.devEmails, ({ input }) =>
            Promise.resolve({
                kind: 'ok',
                body: {
                    emails: devOutbox.sentTo(input.query.to.trim().toLowerCase()).map((message) => ({
                        template: message.template,
                        to: message.to,
                        locale: message.locale,
                        ...renderEmail(message),
                    })),
                },
            }),
        );
    }
    return router;
}
