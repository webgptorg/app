import { Hono } from 'hono';

import { createAccountFlows } from '../../domain/auth/account';
import { authenticateRelay } from '../../domain/registry/authenticate-relay';
import { createEngineCreationPolicy } from '../../domain/registration/engine-creation-policy';
import { createLicenseService, OPEN_LICENSE_GATE } from '../../domain/licensing/license-service';
import { toBase64Url } from '../../domain/auth/secrets';
import { INSTALL_SCRIPT_PATHS } from '../../domain/registration/installation-options';
import type { RouteContract } from '../../shared/api/contract';
import type { DashboardDeps } from '../deps';
import { API_MOUNT, createApiRouter } from './api-router';
import { createRouteBinder } from './bind-route';
import { bindInstallScriptRoutes } from './install-script-routes';
import { createInternalRouter, INTERNAL_MOUNT } from './internal-router';
import { createEmailRouter } from './notification-routes';
import { UNSUBSCRIBE_MOUNT } from '../../shared/api/notification-routes';
import { problemResponse } from './problem';
import { securityHeaders, withHeaders } from './security-headers';
import { createV1Router, V1_MOUNT } from './v1-router';
import { createWebhooksRouter, WEBHOOKS_MOUNT } from './webhooks-router';
import { createWellKnownRouter, WELL_KNOWN_MOUNT } from './well-known-router';

export interface HttpAppDeps extends DashboardDeps {
    /** The Workers static assets binding; answers `index.html` for deep links. */
    readonly assets: Fetcher;
    /** True only under the Vite dev server, never in a build. */
    readonly viteDevServer: boolean;
}

const MACHINE_AND_API_MOUNTS = [
    API_MOUNT,
    V1_MOUNT,
    INTERNAL_MOUNT,
    WEBHOOKS_MOUNT,
    WELL_KNOWN_MOUNT,
    UNSUBSCRIBE_MOUNT,
    // Exact paths: a missing install script must be a problem, never the SPA shell, and never cached.
    ...Object.values(INSTALL_SCRIPT_PATHS),
] as const;

const KNOWN_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

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

    const routeTemplates = new WeakMap<Request, string>();
    app.use('*', async (context, next) => {
        await next();
        const { method } = context.req;
        const isApi = MACHINE_AND_API_MOUNTS.some((mount) => isUnder(context.req.path, mount));
        deps.metrics.record({
            name: 'ptbk_dashboard_requests_total',
            route:
                routeTemplates.get(context.req.raw) ??
                (isApi || (method !== 'GET' && method !== 'HEAD') ? 'unmatched' : 'assets'),
            method: KNOWN_METHODS.has(method) ? method : 'OTHER',
            status: context.res.status,
        });
        context.res = withHeaders(context.res, isApi ? { ...headers, 'Cache-Control': 'no-store' } : headers);
    });

    const accounts = createAccountFlows(deps);
    const routes = createRouteBinder({
        authorizer: deps.authorizer,
        rateLimiter: deps.rateLimiter,
        logger: deps.logger,
        resolveSession: (token) => accounts.resolveSession(token),
        authenticateRelay: (authorization, defer) => authenticateRelay(deps, authorization, defer),
        routeTemplates,
        signatures: {
            'stripe-signature': async (payload, signature) => {
                if (deps.billing === null) {
                    return { kind: 'invalid' };
                }
                const verified = await deps.billing.verifyWebhook(payload, signature);
                return verified.kind === 'verified' ? { kind: 'verified', payload: verified.event } : verified;
            },
        },
    });
    const { licensing } = deps;
    const licenses =
        licensing === null || deps.config.billing.adapter !== 'website'
            ? null
            : createLicenseService({
                  mode: deps.config.billing.enforcement,
                  api: licensing.licenses,
                  store: licensing.store,
                  engines: deps.engines,
                  teams: deps.teams,
                  clock: deps.clock,
              });
    const licenseGate = licenses?.gate ?? OPEN_LICENSE_GATE;
    const policy = createEngineCreationPolicy({ ...deps, licenseGate });
    const routers = [
        [API_MOUNT, createApiRouter({ ...deps, policy, routes, licenses, licenseGate })],
        [V1_MOUNT, createV1Router({ ...deps, policy, routes })],
        [INTERNAL_MOUNT, createInternalRouter({ ...deps, routes })],
        [WEBHOOKS_MOUNT, createWebhooksRouter({ billing: deps.billing, routes })],
        [WELL_KNOWN_MOUNT, createWellKnownRouter({ ...deps, routes })],
        [UNSUBSCRIBE_MOUNT, createEmailRouter({ ...deps, routes })],
    ] as const;
    for (const [mount, router] of routers) {
        // An unknown path under an API prefix is a problem, never the SPA shell.
        router.all('*', () => problemResponse(404, 'not-found'));
        app.route(mount, router);
    }
    bindInstallScriptRoutes(app, { ...deps, routes });
    for (const path of Object.values(INSTALL_SCRIPT_PATHS)) {
        // Strict routing leaves `/install.sh/` to the SPA fallback, and bash runs piped HTML line by line.
        app.all(`${path}/*`, () => problemResponse(404, 'not-found'));
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
