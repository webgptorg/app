import type { Hono } from 'hono';

import { createConsoleLogger } from '../adapters/console-logger';
import { cryptoRandom } from '../adapters/crypto-random';
import { createCloudflareEmailSender } from '../adapters/email/cloudflare-email-sender';
import { createDatabase } from '../adapters/db/client';
import { createD1AuthStore } from '../adapters/db/d1-auth-store';
import { systemClock } from '../adapters/system-clock';
import { createSimpleWebAuthnRelyingParty } from '../adapters/webauthn/simple-webauthn-relying-party';
import { createAuthorizer } from '../domain/authz/authorizer';
import { DASHBOARD_POLICY } from '../domain/authz/policy';
import type { Logger } from '../domain/ports/logger';
import { ConfigError, parseConfig, type DashboardConfig } from './config';
import { authLinks, type DashboardDeps } from './deps';
import { createDevAdapters, type DevAdapters } from './dev-adapters';
import { createHttpApp } from './http/create-http-app';
import { problemResponse } from './http/problem';
import { securityHeaders, withHeaders } from './http/security-headers';
import { renderEmail } from './i18n/render-email';
import { createWorkersRateLimiter } from './rate-limiter';

const RP_NAME = 'Promptbook';

function misconfigured(logger: Logger, paths: readonly string[]): Pick<Hono, 'fetch'> {
    logger.error('config.invalid', { paths: paths.join(',') });
    // Fail closed: no request is served on a configuration nobody validated.
    return { fetch: () => withHeaders(problemResponse(503, 'misconfigured'), securityHeaders('production')) };
}

function emailSender(env: Env, config: DashboardConfig, dev: DevAdapters) {
    switch (config.adapters.email) {
        case 'fake':
            return { email: dev.outbox, devOutbox: dev.outbox };
        case 'cloudflare':
            return env.EMAIL === undefined
                ? null
                : {
                      email: createCloudflareEmailSender({
                          binding: env.EMAIL,
                          from: config.emailFrom,
                          render: renderEmail,
                      }),
                      devOutbox: null,
                  };
    }
}

function rateLimiter(env: Env, config: DashboardConfig, dev: DevAdapters) {
    switch (config.adapters.rateLimit) {
        case 'memory':
            return dev.rateLimiter;
        case 'workers':
            return createWorkersRateLimiter({
                clock: systemClock,
                hmacKey: config.rateLimitHmacKey,
                options: env.RATE_LIMIT_OPTIONS,
                verify: env.RATE_LIMIT_VERIFY,
                publicRead: env.RATE_LIMIT_PUBLIC_READ,
                hourly: env.HOURLY_RATE_LIMITER,
            });
    }
}

/** The composition root. Called per request: building it is cheap; state that must outlive a request is in `devAdapters`. */
export function createDashboard(
    env: Env,
    options: { readonly viteDevServer: boolean; readonly devAdapters?: DevAdapters },
): Pick<Hono, 'fetch'> {
    let config: DashboardConfig;
    try {
        config = parseConfig(env);
    } catch (error) {
        if (!(error instanceof ConfigError)) {
            throw error;
        }
        return misconfigured(createConsoleLogger({ service: 'dashboard' }), error.paths);
    }
    const logger = createConsoleLogger({ service: 'dashboard', environment: config.environment });
    const dev = options.devAdapters ?? createDevAdapters();
    const email = emailSender(env, config, dev);
    if (email === null) {
        return misconfigured(logger, ['EMAIL']);
    }
    const deps: DashboardDeps = {
        config,
        clock: systemClock,
        random: cryptoRandom,
        logger,
        authorizer: createAuthorizer({ clock: systemClock, policy: DASHBOARD_POLICY }),
        store: createD1AuthStore(createDatabase(env.DB)),
        relyingParty: createSimpleWebAuthnRelyingParty({ origin: config.dashboardOrigin, rpName: RP_NAME }),
        rateLimiter: rateLimiter(env, config, dev),
        links: authLinks(config.dashboardOrigin),
        ...email,
    };
    return createHttpApp({ ...deps, assets: env.ASSETS, viteDevServer: options.viteDevServer }).app;
}
