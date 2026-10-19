import type { Hono } from 'hono';

import { createConsoleLogger } from '../adapters/console-logger';
import { cryptoRandom } from '../adapters/crypto-random';
import { createDatabase } from '../adapters/db/client';
import { systemClock } from '../adapters/system-clock';
import { createAuthorizer } from '../domain/authz/authorizer';
import { DASHBOARD_POLICY } from '../domain/authz/policy';
import { ConfigError, parseConfig, type DashboardConfig } from './config';
import type { DashboardDeps } from './deps';
import { createHttpApp } from './http/create-http-app';
import { problemResponse } from './http/problem';
import { securityHeaders, withHeaders } from './http/security-headers';

/** The composition root. Called per request: building it is cheap and keeps no state between requests. */
export function createDashboard(env: Env, options: { readonly viteDevServer: boolean }): Pick<Hono, 'fetch'> {
    let config: DashboardConfig;
    try {
        config = parseConfig(env);
    } catch (error) {
        if (!(error instanceof ConfigError)) {
            throw error;
        }
        const logger = createConsoleLogger({ service: 'dashboard' });
        logger.error('config.invalid', { paths: error.paths.join(',') });
        // Fail closed: no request is served on a configuration nobody validated.
        return { fetch: () => withHeaders(problemResponse(503, 'misconfigured'), securityHeaders('production')) };
    }
    const logger = createConsoleLogger({ service: 'dashboard', environment: config.environment });
    const deps: DashboardDeps = {
        config,
        clock: systemClock,
        random: cryptoRandom,
        logger,
        db: createDatabase(env.DB),
        authorizer: createAuthorizer({ clock: systemClock, policy: DASHBOARD_POLICY }),
    };
    return createHttpApp({ ...deps, assets: env.ASSETS, viteDevServer: options.viteDevServer });
}
