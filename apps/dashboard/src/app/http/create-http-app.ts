import { Hono } from 'hono';

import type { DashboardDeps } from '../deps';
import { API_MOUNT, createApiRouter } from './api-router';
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

export function createHttpApp(deps: HttpAppDeps): Hono {
    const headers = securityHeaders(
        deps.viteDevServer && deps.config.environment === 'dev' ? 'vite-dev-server' : 'production',
    );
    const app = new Hono();

    app.use('*', async (context, next) => {
        await next();
        const isApi = MACHINE_AND_API_MOUNTS.some((mount) => isUnder(context.req.path, mount));
        context.res = withHeaders(context.res, isApi ? { ...headers, 'Cache-Control': 'no-store' } : headers);
    });

    const routers = [
        [API_MOUNT, createApiRouter(deps)],
        [V1_MOUNT, createV1Router(deps)],
        [INTERNAL_MOUNT, createInternalRouter()],
        [WEBHOOKS_MOUNT, createWebhooksRouter()],
    ] as const;
    for (const [mount, router] of routers) {
        // An unknown path under an API prefix is a problem, never the SPA shell.
        router.all('*', () => problemResponse(404, 'not-found'));
        app.route(mount, router);
    }

    app.on(['GET', 'HEAD'], '*', (context) => deps.assets.fetch(context.req.raw));

    app.notFound(() => problemResponse(404, 'not-found'));
    app.onError((error) => {
        deps.logger.error('http.unhandled-error', { error: error.name });
        return problemResponse(500, 'internal');
    });

    return app;
}
