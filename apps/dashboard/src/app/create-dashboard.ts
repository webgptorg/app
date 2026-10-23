import type { Hono } from 'hono';

import { createFakeBillingProvider } from '../adapters/billing/fake-billing-provider';
import { createStripeApi, createStripeBillingProvider } from '../adapters/billing/stripe-billing-provider';
import { createStripeWebhookVerifier, rejectAllWebhooks } from '../adapters/billing/stripe-webhook-verifier';
import { createConsoleLogger } from '../adapters/console-logger';
import { cryptoRandom } from '../adapters/crypto-random';
import { createDohDnsResolver } from '../adapters/dns/doh-dns-resolver';
import { createCloudflareEmailSender } from '../adapters/email/cloudflare-email-sender';
import { createMeteredEmailSender } from '../adapters/email/metered-email-sender';
import { createAnalyticsEngineMetrics } from '../adapters/monitoring/analytics-engine-metrics';
import { createDatabase } from '../adapters/db/client';
import { createD1AuthStore } from '../adapters/db/d1-auth-store';
import { createD1BillingStore } from '../adapters/db/d1-billing-store';
import { createD1CustomHostnameStore } from '../adapters/db/d1-custom-hostname-store';
import {
    createD1EngineStore,
    createD1LinkCodeStore,
    createD1PlatformEngineStore,
} from '../adapters/db/d1-registration-store';
import { createD1RegistryReader, createD1RelayTokenStore } from '../adapters/db/d1-registry-store';
import { createD1HeartbeatEngineReader } from '../adapters/db/d1-status-store';
import { createMemoryRateLimiter } from '../adapters/rate-limit/memory-rate-limiter';
import { createDurableObjectEngineStatus } from '../adapters/status/durable-object-engine-status';
import { systemClock } from '../adapters/system-clock';
import { systemTimer } from '../adapters/system-timer';
import { createSimpleWebAuthnRelyingParty } from '../adapters/webauthn/simple-webauthn-relying-party';
import { createAuthorizer } from '../domain/authz/authorizer';
import type { BillingEvent, BillingProvider } from '../domain/billing/billing-provider';
import { createBillingService } from '../domain/billing/billing-service';
import { createSubscriptionEntitlements } from '../domain/billing/entitlements';
import { DASHBOARD_POLICY } from '../domain/authz/policy';
import type { Logger } from '../domain/ports/logger';
import type { DashboardMetrics } from '../domain/monitoring/dashboard-metrics';
import { ConfigError, parseConfig, type DashboardConfig } from './config';
import { authLinks, type DashboardDeps } from './deps';
import { createDevAdapters, type DevAdapters } from './dev-adapters';
import { createHttpApp } from './http/create-http-app';
import { problemResponse } from './http/problem';
import { securityHeaders, withHeaders } from './http/security-headers';
import { renderEmail } from './i18n/render-email';
import { createWorkersRateLimiter, rateLimitRules } from './rate-limiter';

const RP_NAME = 'Promptbook';

function misconfigured(logger: Logger, paths: readonly string[]): Pick<Hono, 'fetch'> {
    logger.error('config.invalid', { paths: paths.join(',') });
    // Fail closed: no request is served on a configuration nobody validated.
    return { fetch: () => withHeaders(problemResponse(503, 'misconfigured'), securityHeaders('production')) };
}

/** Analytics Engine everywhere but dev, where the counters stay in the isolate for the monitoring job to read. */
export function dashboardMetrics(env: Env, config: DashboardConfig, dev: DevAdapters): DashboardMetrics {
    return config.environment === 'dev' ? dev.metrics : createAnalyticsEngineMetrics(env.OPS_METRICS);
}

/**
 * The configured email adapter, counted per template and outcome, or null when its binding is missing; the engines'
 * status objects and the monitoring job send through it too.
 */
export function emailSender(env: Env, config: DashboardConfig, dev: DevAdapters, metrics: DashboardMetrics) {
    switch (config.adapters.email) {
        case 'fake':
            return { email: createMeteredEmailSender(dev.outbox, metrics), devOutbox: dev.outbox };
        case 'cloudflare':
            return env.EMAIL === undefined
                ? null
                : {
                      email: createMeteredEmailSender(
                          createCloudflareEmailSender({
                              binding: env.EMAIL,
                              from: config.emailFrom,
                              render: renderEmail,
                          }),
                          metrics,
                      ),
                      devOutbox: null,
                  };
    }
}

function billingProvider(
    config: DashboardConfig,
    dev: DevAdapters,
    deliver: (event: BillingEvent, signal: AbortSignal) => Promise<unknown>,
): BillingProvider | null {
    const verifyWebhook =
        config.stripeWebhookSecret === null
            ? rejectAllWebhooks
            : createStripeWebhookVerifier({ secret: config.stripeWebhookSecret, clock: systemClock });
    switch (config.adapters.billing) {
        case 'fake':
            return createFakeBillingProvider({
                state: dev.billing,
                random: cryptoRandom,
                clock: systemClock,
                dashboardOrigin: config.dashboardOrigin,
                verifyWebhook,
                deliver,
            });
        case 'stripe':
            return config.stripeSecretKey === null
                ? null
                : createStripeBillingProvider({
                      api: createStripeApi(config.stripeSecretKey),
                      dashboardOrigin: config.dashboardOrigin,
                      verifyWebhook,
                  });
    }
}

function rateLimiter(env: Env, config: DashboardConfig, dev: DevAdapters) {
    switch (config.adapters.rateLimit) {
        case 'memory':
            return createMemoryRateLimiter(systemClock, rateLimitRules(config), dev.rateLimitWindows);
        case 'workers':
            return createWorkersRateLimiter({
                clock: systemClock,
                hmacKey: config.rateLimitHmacKey,
                options: env.RATE_LIMIT_OPTIONS,
                verify: env.RATE_LIMIT_VERIFY,
                publicRead: env.RATE_LIMIT_PUBLIC_READ,
                webhook: env.RATE_LIMIT_WEBHOOK,
                registry: env.RATE_LIMIT_REGISTRY,
                heartbeat: env.RATE_LIMIT_HEARTBEAT,
                hourly: env.HOURLY_RATE_LIMITER,
                rules: rateLimitRules(config),
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
    const metrics = dashboardMetrics(env, config, dev);
    const email = emailSender(env, config, dev, metrics);
    if (email === null) {
        return misconfigured(logger, ['EMAIL']);
    }
    const db = createDatabase(env.DB);
    const billingStore = createD1BillingStore(db);
    // The fake's Checkout completes through the webhook's own handler, which needs the service it belongs to.
    const provider = billingProvider(config, dev, (event, signal) => billing.handleEvent(event, signal));
    if (provider === null) {
        return misconfigured(logger, ['STRIPE_SECRET_KEY']);
    }
    const billing = createBillingService({
        store: billingStore,
        provider,
        catalogue: config.plans,
        clock: systemClock,
        logger,
    });
    const customHostnames = createD1CustomHostnameStore(db);
    const deps: DashboardDeps = {
        config,
        clock: systemClock,
        random: cryptoRandom,
        timer: systemTimer,
        logger,
        metrics,
        authorizer: createAuthorizer({ clock: systemClock, policy: DASHBOARD_POLICY }),
        store: createD1AuthStore(db),
        billing,
        entitlements: createSubscriptionEntitlements({ store: billingStore, catalogue: config.plans }),
        linkCodes: createD1LinkCodeStore(db),
        engines: createD1EngineStore(db),
        platformEngines: createD1PlatformEngineStore(db),
        relayTokens: createD1RelayTokenStore(db),
        registry: createD1RegistryReader(db),
        engineHostnames: customHostnames,
        customHostnames,
        dns: createDohDnsResolver({ fetch: (input, init) => fetch(input, init) }),
        heartbeatEngines: createD1HeartbeatEngineReader(db),
        engineStatus: createDurableObjectEngineStatus(env.ENGINE_STATUS),
        relyingParty: createSimpleWebAuthnRelyingParty({ origin: config.dashboardOrigin, rpName: RP_NAME }),
        rateLimiter: rateLimiter(env, config, dev),
        links: authLinks(config.dashboardOrigin),
        ...email,
    };
    return createHttpApp({ ...deps, assets: env.ASSETS, viteDevServer: options.viteDevServer }).app;
}
