import { Hono } from 'hono';

import { createAccountFlows } from '../../domain/auth/account';
import { toBase64Url } from '../../domain/auth/secrets';
import type { RouteContract } from '../../shared/api/contract';
import type { DashboardDeps } from '../deps';
import { API_MOUNT, createApiRouter } from './api-router';
import { createRouteBinder } from './bind-route';
import { createInternalRouter, INTERNAL_MOUNT } from './internal-router';
import { problemResponse } from './problem';
import { securityHeaders, withHeaders } from './security-headers';
import { createV1Router, V1_MOUNT } from './v1-router';
import { createWebhooksRouter, WEBHOOKS_MOUNT } from './webhooks-router';

export interface HttpAppDeps extends DashboardDeps {
    /** The Workers static assets binding; answers `index.html` for deep links. */
    readonly assets: Fetcher;
    /** True only under the Vite dev server, never in a build. */
    readonly viteDevServer: boolean;
}

const MACHINE_AND_API_MOUNTS = [API_MOUNT, V1_MOUNT, INTERNAL_MOUNT, WEBHOOKS_MOUNT] as const;

function isUnder(path: string, mount: string): boolean {
    return path === mount || path.startsWith(`${mount}/`);
}

export interface HttpApp {
    readonly app: Hono;
    /** Every route mounted through the route helper, for the route-table test. */
    readonly routes: readonly RouteContract[];
}

export function createHttpApp(deps: HttpAppDeps): HttpApp {
    const headers = securityHeaders(
        deps.viteDevServer && deps.config.environment === 'dev' ? 'vite-dev-server' : 'production',
    );
    const app = new Hono();

    app.use('*', async (context, next) => {
        await next();
        const isApi = MACHINE_AND_API_MOUNTS.some((mount) => isUnder(context.req.path, mount));
        context.res = withHeaders(context.res, isApi ? { ...headers, 'Cache-Control': 'no-store' } : headers);
    });

    const accounts = createAccountFlows(deps);
    const routes = createRouteBinder({
        authorizer: deps.authorizer,
        rateLimiter: deps.rateLimiter,
        logger: deps.logger,
        resolveSession: (token) => accounts.resolveSession(token),
        signatures: {
            'stripe-signature': async (payload, signature) => {
                const verified = await deps.billing.verifyWebhook(payload, signature);
                return verified.kind === 'verified' ? { kind: 'verified', payload: verified.event } : verified;
            },
        },
    });
    const routers = [
        [API_MOUNT, createApiRouter({ ...deps, routes })],
        [V1_MOUNT, createV1Router({ config: deps.config, routes })],
        [INTERNAL_MOUNT, createInternalRouter()],
        [WEBHOOKS_MOUNT, createWebhooksRouter({ billing: deps.billing, routes })],
    ] as const;
    for (const [mount, router] of routers) {
        // An unknown path under an API prefix is a problem, never the SPA shell.
        router.all('*', () => problemResponse(404, 'not-found'));
        app.route(mount, router);
    }

    app.on(['GET', 'HEAD'], '*', (context) => deps.assets.fetch(context.req.raw));

    app.notFound(() => problemResponse(404, 'not-found'));
    app.onError((error) => {
        const correlationId = toBase64Url(deps.random.bytes(12));
        deps.logger.error('http.unhandled-error', { error: error.name, correlationId });
        return problemResponse(500, 'internal', correlationId);
    });

    return { app, routes: routes.routes };
}
