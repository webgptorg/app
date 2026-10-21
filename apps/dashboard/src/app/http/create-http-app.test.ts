import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../../adapters/email/fake-email-sender';
import { createMemoryLogger } from '../../adapters/memory-logger';
import { createMemoryRateLimiter } from '../../adapters/rate-limit/memory-rate-limiter';
import { createSimpleWebAuthnRelyingParty } from '../../adapters/webauthn/simple-webauthn-relying-party';
import { createAuthorizer } from '../../domain/authz/authorizer';
import { DASHBOARD_POLICY } from '../../domain/authz/policy';
import { syntheticStripeKey, syntheticWebhookSecret, TEST_PLANS } from '../../testing/billing-fixtures';
import { createMemoryAuthStore } from '../../testing/memory-auth-store';
import { createMemoryRegistrationStores } from '../../testing/memory-registration-store';
import { createTestBilling } from '../../testing/test-billing';
import { DEV_RATE_LIMIT_HMAC_KEY, parseConfig } from '../config';
import { authLinks } from '../deps';
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
        INSTALL_COMMAND: 'bun run dev:link {linkCode}',
        ADAPTERS:
            options.environment === 'dev'
                ? { email: 'fake', billing: 'fake', rateLimit: 'memory' }
                : { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
        EMAIL_FROM: 'no-reply@ptbk.test',
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
    const { app: http } = createHttpApp({
        config,
        clock,
        random: { bytes: (n) => new Uint8Array(n) },
        logger,
        authorizer: createAuthorizer({ clock, policy: DASHBOARD_POLICY }),
        store: createMemoryAuthStore(),
        relyingParty: createSimpleWebAuthnRelyingParty({ origin: 'https://app.ptbk.test', rpName: 'Promptbook' }),
        email: createFakeEmailSender(),
        rateLimiter: createMemoryRateLimiter(clock),
        links: authLinks('https://app.ptbk.test'),
        devOutbox: null,
        billing,
        entitlements,
        ...createMemoryRegistrationStores({ orgExists: () => true }),
        assets: { fetch: assets } as unknown as Fetcher,
        viteDevServer: options.viteDevServer,
    });
    return { http, logger };
}

describe('createHttpApp', () => {
    it('serves health and the UI API without caching, and 404s unknown API paths as problems', async () => {
        const { http } = app({ environment: 'staging', viteDevServer: false });
        const health = await http.request('/v1/health');
        expect(await health.json()).toEqual({ ok: true, environment: 'staging' });
        expect(health.headers.get('Cache-Control')).toBe('no-store');
        const environment = await http.request('/api/environment');
        expect(await environment.json()).toEqual({ environment: 'staging' });
        expect(environment.headers.get('Cache-Control')).toBe('no-store');
        const unknown = await http.request('/internal/v1/engines/x');
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
