import { describe, expect, it } from 'vitest';

import { assertMountable } from '../../src/app/http/bind-route';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { RAW_BODY } from '../../src/shared/api/contract';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';

/** Routes anyone may call without a session. Adding one is a security review point. */
const PUBLIC_ROUTES = [
    'GET /.well-known/security.txt',
    'GET /api/__dev/emails',
    'GET /api/abuse-contact',
    'GET /api/environment',
    'GET /v1/health',
    'POST /api/auth/recovery/options',
    'POST /api/auth/recovery/request',
    'POST /api/auth/recovery/verify',
    'POST /api/auth/signin/options',
    'POST /api/auth/signin/verify',
    'POST /api/auth/signup/options',
    'POST /api/auth/signup/start',
    'POST /api/auth/signup/verify',
    'POST /api/invites/join/options',
    'POST /api/invites/join/verify',
    'POST /api/invites/preview',
    'POST /api/invites/signin/verify',
];

const MOUNTS = ['/api', '/v1', '/internal', '/webhooks', '/.well-known'];

/**
 * I-05's abuse review: every endpoint reachable without a session and the limits it is held to, per client IP (or per
 * relay key) and per engine. The values are `RATE_LIMITS` (README, "Rate limits"); changing this table is a review
 * point. Engine creation is limited through `Entitlements`, not here (ADR 0017).
 */
const ANONYMOUS_LIMITS = {
    'GET /.well-known/security.txt': ['public-read-ip', null],
    'GET /api/__dev/emails': ['public-read-ip', null],
    'GET /api/abuse-contact': ['public-read-ip', null],
    'GET /api/environment': ['public-read-ip', null],
    'GET /internal/v1/engines/:engineId': ['registry-relay', null],
    'GET /v1/health': ['public-read-ip', null],
    'POST /api/auth/recovery/options': ['options-ip', null],
    'POST /api/auth/recovery/request': ['recovery-request-ip', null],
    'POST /api/auth/recovery/verify': ['verify-ip', null],
    'POST /api/auth/signin/options': ['options-ip', null],
    'POST /api/auth/signin/verify': ['verify-ip', null],
    'POST /api/auth/signup/options': ['options-ip', null],
    'POST /api/auth/signup/start': ['signup-start-ip', null],
    'POST /api/auth/signup/verify': ['verify-ip', null],
    'POST /api/invites/join/options': ['options-ip', null],
    'POST /api/invites/join/verify': ['verify-ip', null],
    'POST /api/invites/preview': ['verify-ip', null],
    'POST /api/invites/signin/verify': ['verify-ip', null],
    'POST /v1/engines/:engineId/heartbeat': ['heartbeat-ip', 'heartbeat-engine'],
    'POST /v1/engines/register': ['registration-ip', null],
    'POST /webhooks/stripe': ['webhook-ip', null],
    'PUT /internal/v1/relays/presence': ['presence-relay', null],
};

describe('route table', () => {
    // The dev configuration mounts the most routes (it adds the dev outbox).
    const harness = createAuthHarness({ store: createMemoryAuthStore() });
    const declared = harness.routes.map((route) => `${route.method} ${route.path}`);

    it('mounts nothing that bypassed the route helper', () => {
        const mounted = harness.http.routes
            // Middleware and the per-mount 404 catch-alls are `ALL`; the SPA fallback serves static assets only.
            .filter(
                (route) => route.method !== 'ALL' && !(route.path === '/*' && ['GET', 'HEAD'].includes(route.method)),
            )
            .map((route) => `${route.method} ${route.path}`);
        expect(mounted.sort()).toEqual([...declared].sort());
        for (const route of harness.http.routes.filter((r) => r.method === 'ALL')) {
            expect(route.path === '/*' || MOUNTS.some((mount) => route.path === `${mount}/*`), route.path).toBe(true);
        }
    });

    it('gives every route an input schema per part, an auth mode, a permission or a rate limit', () => {
        for (const route of harness.routes) {
            const mount = MOUNTS.find((candidate) => route.path.startsWith(`${candidate}/`)) ?? '';
            expect(() => {
                assertMountable(route, mount);
            }, `${route.method} ${route.path}`).not.toThrow();
            expect(['public', 'session', 'stripe-signature', 'engine-signature', 'relay-token']).toContain(route.auth);
            expect(route.input.body === null || route.method !== 'GET').toBe(true);
        }
    });

    it('verifies exactly the Stripe webhook by signature', () => {
        const signed = harness.routes.filter((route) => route.auth === 'stripe-signature');
        expect(signed.map((route) => `${route.method} ${route.path} ${String(route.rateLimit)}`)).toEqual([
            'POST /webhooks/stripe webhook-ip',
        ]);
    });

    it('takes exactly registration and heartbeats as engine-signed, verified before anything reads them', () => {
        const signed = harness.routes.filter((route) => route.auth === 'engine-signature');
        expect(
            signed.map(
                (route) => `${route.method} ${route.path} ${String(route.rateLimit)} ${String(route.engineRateLimit)}`,
            ),
        ).toEqual([
            'POST /v1/engines/register registration-ip undefined',
            'POST /v1/engines/:engineId/heartbeat heartbeat-ip heartbeat-engine',
        ]);
    });

    it('passes a raw body to the heartbeat only', () => {
        expect(harness.routes.filter((route) => route.input.body === RAW_BODY).map((route) => route.path)).toEqual([
            '/v1/engines/:engineId/heartbeat',
        ]);
    });

    it('takes a relay key on exactly the registry read and the presence report, limited per relay', () => {
        const relayRoutes = harness.routes.filter((route) => route.auth === 'relay-token');
        expect(relayRoutes.map((route) => `${route.method} ${route.path} ${String(route.rateLimit)}`)).toEqual([
            'GET /internal/v1/engines/:engineId registry-relay',
            'PUT /internal/v1/relays/presence presence-relay',
        ]);
    });

    it('holds every endpoint without a session to its reviewed rate limits', () => {
        const limits = Object.fromEntries(
            harness.routes
                .filter((route) => route.auth !== 'session')
                .map((route) => [`${route.method} ${route.path}`, [route.rateLimit, route.engineRateLimit ?? null]]),
        );
        expect(limits).toEqual(ANONYMOUS_LIMITS);
    });

    it('allows exactly the allowlisted public routes', () => {
        const publicRoutes = harness.routes
            .filter((route) => route.auth === 'public')
            .map((route) => `${route.method} ${route.path}`);
        expect(publicRoutes.sort()).toEqual(PUBLIC_ROUTES);
    });

    it('does not mount the dev outbox without the fake email adapter', async () => {
        const production = createAuthHarness({ store: createMemoryAuthStore(), email: 'cloudflare' });
        expect(production.routes.map((route) => route.path)).not.toContain('/api/__dev/emails');
        for (const path of ['/api/__dev/emails?to=a@example.test', '/api/__dev/emails']) {
            const response = await production.http.request(`https://app.ptbk.test${path}`);
            expect(response.status, path).toBe(404);
            expect(await response.json()).toMatchObject({ code: 'not-found' });
        }
    });
});
