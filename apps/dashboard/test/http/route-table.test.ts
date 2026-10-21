import { describe, expect, it } from 'vitest';

import { assertMountable } from '../../src/app/http/bind-route';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { RAW_BODY } from '../../src/shared/api/contract';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';

/** Routes anyone may call without a session. Adding one is a security review point. */
const PUBLIC_ROUTES = [
    'GET /api/__dev/emails',
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
];

const MOUNTS = ['/api', '/v1', '/internal', '/webhooks'];

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

    it('takes a relay key on exactly the registry read, limited per relay', () => {
        const relayRoutes = harness.routes.filter((route) => route.auth === 'relay-token');
        expect(relayRoutes.map((route) => `${route.method} ${route.path} ${String(route.rateLimit)}`)).toEqual([
            'GET /internal/v1/engines/:engineId registry-relay',
        ]);
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
        const response = await production.http.request('https://app.ptbk.test/api/__dev/emails?to=a@example.test');
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'not-found' });
    });
});
