import { afterEach, describe, expect, it, vi } from 'vitest';

import { syntheticStripeKey, syntheticWebhookSecret, TEST_PLANS } from '../testing/billing-fixtures';
import { stripeEvent, stripeSignatureHeader } from '../testing/stripe-signature';
import { DEV_RATE_LIMIT_HMAC_KEY } from './config';
import { createDashboard } from './create-dashboard';
import { createDevAdapters } from './dev-adapters';

const vars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'http://localhost:5173',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay.ptbk.test', region: 'local' }],
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
    EMAIL_FROM: 'no-reply@ptbk.test',
    RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY,
    BILLING_PLANS: TEST_PLANS,
};
const WEBHOOK_SECRET = syntheticWebhookSecret();
const stagingVars = {
    ...vars,
    ENVIRONMENT: 'staging',
    DASHBOARD_ORIGIN: 'https://app.staging.ptbk.test',
    ADAPTERS: { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
    RATE_LIMIT_HMAC_KEY: 'c3RhZ2luZy1zZWNyZXQta2V5LWZvci1yYXRlLWxpbWl0cy0zMmI',
    STRIPE_SECRET_KEY: syntheticStripeKey(),
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

class FakeBinding {
    fetch(): Promise<Response> {
        return Promise.resolve(new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
    }
}

function env(overrides: Record<string, unknown> = {}): Env {
    return { ...vars, DB: new FakeBinding(), ASSETS: new FakeBinding(), ...overrides } as unknown as Env;
}

/** Runtime bindings are objects with their own prototype; config treats plain objects as vars. */
function runtime<T extends object>(members: T): T {
    return Object.assign(Object.create({}) as T, members);
}

function executionContext() {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (task: Promise<unknown>) => pending.push(task) } as unknown as ExecutionContext;
    return { ctx, settle: () => Promise.all(pending) };
}

function productionBindings() {
    const keys: string[] = [];
    const names: string[] = [];
    const sent: unknown[] = [];
    const binding = runtime({
        limit: ({ key }: { key: string }) => (keys.push(key), Promise.resolve({ success: true })),
    });
    return {
        keys,
        names,
        sent,
        bindings: {
            RATE_LIMIT_OPTIONS: binding,
            RATE_LIMIT_VERIFY: binding,
            RATE_LIMIT_PUBLIC_READ: binding,
            RATE_LIMIT_WEBHOOK: binding,
            HOURLY_RATE_LIMITER: runtime({
                idFromName: (name: string) => (names.push(name), { name }),
                get: () => ({ consume: () => Promise.resolve('allowed') }),
            }),
            EMAIL: runtime({ send: (message: unknown) => (sent.push(message), Promise.resolve({ messageId: 'm' })) }),
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('createDashboard', () => {
    it('serves requests once the configuration parses', async () => {
        const response = await createDashboard(env(), { viteDevServer: false }).fetch(
            new Request('https://app.ptbk.test/v1/health'),
        );
        expect(await response.json()).toEqual({ ok: true, environment: 'dev' });
    });

    it.each([
        ['an unknown var', { DEBUG: 'true' }],
        ['an unknown value', { ENVIRONMENT: 'qa' }],
        ['a fake adapter outside dev', { ENVIRONMENT: 'production', DASHBOARD_ORIGIN: 'https://app.ptbk.io' }],
    ])('fails closed on %s: every request is a 503 problem with production headers', async (_, overrides) => {
        const errors: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((line: string) => errors.push(line));
        const dashboard = createDashboard(env(overrides), { viteDevServer: true });
        for (const path of ['/', '/v1/health', '/api/environment']) {
            const response = await dashboard.fetch(new Request(`https://app.ptbk.test${path}`));
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ status: 503, code: 'misconfigured' });
            expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
        }
        expect(errors).toHaveLength(1);
        expect(JSON.parse(errors[0] ?? '{}')).toMatchObject({ event: 'config.invalid' });
        expect(errors[0]).not.toMatch(/qa|app\.ptbk\.io|true/);
    });

    it('rethrows anything that is not a configuration error', () => {
        const hostile = new Proxy(
            {},
            {
                ownKeys: () => {
                    throw new TypeError('broken binding');
                },
            },
        );
        expect(() => createDashboard(hostile as Env, { viteDevServer: false })).toThrow(TypeError);
    });
});

describe('createDashboard adapter selection', () => {
    it('fails closed when the Cloudflare email adapter has no send_email binding', async () => {
        const errors: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((line: string) => errors.push(line));
        const response = await createDashboard(env(stagingVars), { viteDevServer: false }).fetch(
            new Request('https://app.ptbk.test/v1/health'),
        );
        expect(response.status).toBe(503);
        expect(JSON.parse(errors[0] ?? '{}')).toMatchObject({ event: 'config.invalid', paths: 'EMAIL' });
    });

    it('keys production rate limits by HMAC, per-minute rules on the binding and hourly ones on the Durable Object', async () => {
        const { keys, names, bindings } = productionBindings();
        const dashboard = createDashboard(env({ ...stagingVars, ...bindings }), { viteDevServer: false });
        const headers = { 'CF-Connecting-IP': '192.0.2.44', 'Sec-Fetch-Site': 'same-origin' };
        expect((await dashboard.fetch(new Request('https://app.ptbk.test/api/environment', { headers }))).status).toBe(
            200,
        );
        const { ctx } = executionContext();
        const signup = await dashboard.fetch(
            new Request('https://app.ptbk.test/api/auth/signup/start', {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'person@example.test' }),
            }),
            {},
            ctx,
        );
        expect(signup.status).toBe(202);
        expect(keys).toHaveLength(1);
        expect(names).toHaveLength(1);
        for (const key of [...keys, ...names]) {
            expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(key).not.toContain('192.0.2.44');
        }
        expect(keys[0]).not.toBe(names[0]);
    });

    it('serves the isolate’s dev outbox, which outlives each per-request composition', async () => {
        const devAdapters = createDevAdapters();
        const { ctx, settle } = executionContext();
        const request = new Request('http://localhost:5173/api/auth/signup/start', {
            method: 'POST',
            headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'a@example.test' }),
        });
        const db = runtime({
            prepare: () => ({
                bind: () => ({ raw: () => Promise.resolve([]), all: () => Promise.resolve({ results: [] }) }),
            }),
        });
        expect(
            (await createDashboard(env({ DB: db }), { viteDevServer: false, devAdapters }).fetch(request, {}, ctx))
                .status,
        ).toBe(202);
        await settle();
        await devAdapters.outbox.send(
            { template: 'signup-link', to: 'a@example.test', locale: 'en', link: 'http://localhost:5173/signup#x' },
            new AbortController().signal,
        );
        const next = createDashboard(env(), { viteDevServer: false, devAdapters });
        const response = await next.fetch(new Request('http://localhost:5173/api/__dev/emails?to=a@example.test'));
        expect((await response.json<{ emails: { template: string }[] }>()).emails.at(-1)?.template).toBe('signup-link');
    });

    describe('Stripe webhooks', () => {
        const payload = stripeEvent({ id: 'evt_unknown1', type: 'balance.available', object: { object: 'balance' } });

        function webhook(signature: string) {
            return new Request('https://app.ptbk.test/webhooks/stripe', {
                method: 'POST',
                headers: { 'Stripe-Signature': signature, 'Content-Type': 'application/json' },
                body: payload,
            });
        }

        it('verifies with the configured secret on the Stripe adapter, without calling Stripe', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            const { bindings } = productionBindings();
            const dashboard = createDashboard(env({ ...stagingVars, ...bindings }), { viteDevServer: false });
            const signed = await stripeSignatureHeader(payload, WEBHOOK_SECRET, Date.now());
            expect((await dashboard.fetch(webhook(signed))).status).toBe(200);
            const forged = await stripeSignatureHeader(payload, syntheticWebhookSecret(), Date.now());
            expect((await dashboard.fetch(webhook(forged))).status).toBe(400);
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('refuses every webhook on the dev fake unless a webhook secret is set', async () => {
            const signed = await stripeSignatureHeader(payload, WEBHOOK_SECRET, Date.now());
            expect((await createDashboard(env(), { viteDevServer: false }).fetch(webhook(signed))).status).toBe(400);
            const withSecret = createDashboard(env({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET }), {
                viteDevServer: false,
            });
            expect((await withSecret.fetch(webhook(signed))).status).toBe(200);
        });
    });
});
