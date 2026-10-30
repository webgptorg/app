import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../../adapters/email/fake-email-sender';
import { createManualTimer } from '../../testing/manual-timer';
import { createMemoryLogger } from '../../adapters/memory-logger';
import { createMemoryRateLimiter } from '../../adapters/rate-limit/memory-rate-limiter';
import { createSimpleWebAuthnRelyingParty } from '../../adapters/webauthn/simple-webauthn-relying-party';
import { createAuthorizer } from '../../domain/authz/authorizer';
import { DASHBOARD_POLICY } from '../../domain/authz/policy';
import { syntheticStripeKey, syntheticWebhookSecret, TEST_PLANS } from '../../testing/billing-fixtures';
import { TEST_INSTALL_VARS } from '../../testing/install-fixtures';
import { createFakeDnsResolver } from '../../testing/fake-dns-resolver';
import { createMemoryAuthStore } from '../../testing/memory-auth-store';
import { createMemoryCustomHostnameStore } from '../../testing/memory-custom-hostname-store';
import { createMemoryTeamStore } from '../../testing/memory-team-store';
import { createMemoryRegistrationStores } from '../../testing/memory-registration-store';
import { createMemoryEngineHostnameStore, createMemoryRelayTokenStore } from '../../testing/memory-registry-stores';
import { createMemoryRelayPresenceStore } from '../../testing/memory-relay-presence-store';
import { createTestBilling } from '../../testing/test-billing';
import { DEV_RATE_LIMIT_HMAC_KEY, parseConfig } from '../config';
import { authLinks } from '../deps';
import { createMemoryDashboardMetrics } from '../../adapters/monitoring/memory-dashboard-metrics';
import { createHttpApp } from './create-http-app';

const clock = { nowMs: () => 0 };

function app(options: {
    readonly environment: 'dev' | 'staging';
    readonly viteDevServer: boolean;
    readonly assets?: (request: Request) => Promise<Response>;
}) {
    const config = parseConfig({
        ENVIRONMENT: options.environment,
        DASHBOARD_ORIGIN: 'https://app.ptbk.test',
        ENGINE_DOMAIN: 'engines.ptbk.test',
        RELAYS: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
        ...TEST_INSTALL_VARS,
        ADAPTERS:
            options.environment === 'dev'
                ? { email: 'fake', billing: 'fake', rateLimit: 'memory' }
                : { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
        EMAIL_FROM: 'no-reply@ptbk.test',
        ABUSE_EMAIL: 'abuse@ptbk.test',
        RATE_LIMIT_HMAC_KEY: options.environment === 'dev' ? DEV_RATE_LIMIT_HMAC_KEY : 'k'.repeat(43),
        BILLING_PLANS: TEST_PLANS,
        ...(options.environment === 'dev'
            ? {}
            : { STRIPE_SECRET_KEY: syntheticStripeKey(), STRIPE_WEBHOOK_SECRET: syntheticWebhookSecret() }),
    });
    const { billing, entitlements } = createTestBilling({
        clock,
        catalogue: config.plans,
        dashboardOrigin: 'https://app.ptbk.test',
    });
    const logger = createMemoryLogger();
    const assets = options.assets ?? (() => Promise.resolve(new Response('<!doctype html>')));
    const metrics = createMemoryDashboardMetrics(clock);
    const auth = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: () => true });
    const { app: http } = createHttpApp({
        config,
        clock,
        random: { bytes: (n) => new Uint8Array(n) },
        timer: createManualTimer(),
        logger,
        metrics,
        authorizer: createAuthorizer({ clock, policy: DASHBOARD_POLICY }),
        store: auth,
        relyingParty: createSimpleWebAuthnRelyingParty({ origin: 'https://app.ptbk.test', rpName: 'Promptbook' }),
        email: createFakeEmailSender(),
        rateLimiter: createMemoryRateLimiter(clock),
        links: authLinks('https://app.ptbk.test'),
        devOutbox: null,
        billing,
        entitlements,
        ...registration,
        teams: createMemoryTeamStore({ auth: auth.state, registration: registration.state }),
        relayTokens: createMemoryRelayTokenStore(),
        registry: { findEngine: () => Promise.resolve(null) },
        engineHostnames: createMemoryEngineHostnameStore(),
        customHostnames: createMemoryCustomHostnameStore({
            engines: { findForRegistration: () => Promise.resolve(null) },
            auditLog: { append: () => Promise.resolve() },
        }),
        dns: createFakeDnsResolver(),
        heartbeatEngines: { findEngine: () => Promise.resolve(null) },
        engineStatus: {
            recordHeartbeat: () => Promise.reject(new Error('not reached')),
            getStatus: () => Promise.resolve({ state: 'never-seen' }),
            reset: () => Promise.resolve(),
        },
        relayPresence: createMemoryRelayPresenceStore(),
        assets: { fetch: assets } as unknown as Fetcher,
        viteDevServer: options.viteDevServer,
    });
    return { http, logger, metrics };
}

describe('createHttpApp', () => {
    it('counts every request by route template, method and status, never by its path (I-04)', async () => {
        const { http, metrics } = app({ environment: 'staging', viteDevServer: false });
        await http.request('/v1/health');
        await http.request('/api/nope/abcdefghijklmnopqrstuvwxyz');
        await http.request('/engines/abcdefghijklmnopqrstuvwxyz');
        await http.request('/engines/x', { method: 'PROPFIND' });
        expect(metrics.records.map((record) => record.metric)).toEqual([
            { name: 'ptbk_dashboard_requests_total', route: '/v1/health', method: 'GET', status: 200 },
            { name: 'ptbk_dashboard_requests_total', route: 'unmatched', method: 'GET', status: 404 },
            { name: 'ptbk_dashboard_requests_total', route: 'assets', method: 'GET', status: 200 },
            { name: 'ptbk_dashboard_requests_total', route: 'unmatched', method: 'OTHER', status: 404 },
        ]);
    });

    it('serves health and the UI API without caching, and 404s unknown API paths as problems', async () => {
        const { http } = app({ environment: 'staging', viteDevServer: false });
        const health = await http.request('/v1/health');
        expect(await health.json()).toEqual({ ok: true, environment: 'staging' });
        expect(health.headers.get('Cache-Control')).toBe('no-store');
        const environment = await http.request('/api/environment');
        expect(await environment.json()).toEqual({ environment: 'staging' });
        expect(environment.headers.get('Cache-Control')).toBe('no-store');
        const unknown = await http.request('/internal/v1/unknown');
        expect(unknown.status).toBe(404);
        expect(unknown.headers.get('Content-Type')).toBe('application/problem+json');
        const page = await http.request('/engines/x');
        expect(page.headers.get('Cache-Control')).toBeNull();
    });

    it('relaxes the CSP and drops HSTS only under the Vite dev server in dev', async () => {
        const response = await app({ environment: 'dev', viteDevServer: true }).http.request('/');
        expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'unsafe-inline'");
        expect(response.headers.get('Strict-Transport-Security')).toBeNull();
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('keeps the production policy outside dev even if the dev-server flag is set', async () => {
        const response = await app({ environment: 'staging', viteDevServer: true }).http.request('/');
        expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
        expect(response.headers.get('Content-Security-Policy')).toContain("require-trusted-types-for 'script'");
        expect(response.headers.get('Strict-Transport-Security')).not.toBeNull();
    });

    it('answers an unhandled error with a 500 problem and logs no message or content', async () => {
        const { http, logger } = app({
            environment: 'dev',
            viteDevServer: false,
            assets: () => Promise.reject(new Error('prompt: summarise the board minutes')),
        });
        const response = await http.request('/');
        expect(response.status).toBe(500);
        const problem = await response.json<{ correlationId: string }>();
        expect(problem).toMatchObject({ status: 500, code: 'internal', correlationId: expect.any(String) as string });
        expect(logger.entries).toEqual([
            {
                level: 'error',
                event: 'http.unhandled-error',
                fields: { error: 'Error', correlationId: problem.correlationId },
            },
        ]);
    });
});
