import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMemoryLogger } from '../../adapters/memory-logger';
import type { ActiveSession } from '../../domain/auth/account';
import { createAuthorizer, type Actor } from '../../domain/authz/authorizer';
import { DASHBOARD_POLICY } from '../../domain/authz/policy';
import { orgIdSchema, relayTokenIdSchema, userIdSchema } from '../../domain/ids';
import type { RateLimitOutcome } from '../../domain/ports/rate-limiter';
import { defineRoute, NO_INPUT, type RouteContract } from '../../shared/api/contract';
import { createRouteBinder, type RouteHandler } from './bind-route';

const ENGINE = 'a'.repeat(26);
const TOKEN = 'T'.repeat(43);
const USER = userIdSchema.parse('u'.repeat(26));
const ORG = orgIdSchema.parse('o'.repeat(26));

const renameEngine = defineRoute({
    method: 'POST',
    path: '/api/engines/:engineId/name',
    auth: 'public',
    permission: null,
    rateLimit: 'public-read-ip',
    input: {
        params: z.strictObject({ engineId: z.string().regex(/^[a-z2-7]{26}$/) }),
        query: z.strictObject({ dryRun: z.enum(['true', 'false']).optional() }),
        headers: z.strictObject({ 'x-request-kind': z.enum(['rename']).optional() }),
        body: z.strictObject({ name: z.string().min(1).max(64) }),
        maxBodyBytes: 256,
    },
    output: z.strictObject({ name: z.string() }),
    errorCodes: ['engine-not-found'],
});

const sessionRoute = defineRoute({
    method: 'GET',
    path: '/api/me',
    auth: 'session',
    permission: 'account.read',
    rateLimit: null,
    input: NO_INPUT,
    output: z.strictObject({ userId: z.string() }),
    errorCodes: [],
});

function actor(overrides: Partial<Actor> = {}): Actor {
    return {
        userId: USER,
        orgId: ORG,
        orgRole: 'owner',
        platformRole: 'none',
        recoveredAt: null,
        steppedUpAt: null,
        ...overrides,
    };
}

function harness(options: { readonly limit?: RateLimitOutcome; readonly session?: ActiveSession | null } = {}) {
    const logger = createMemoryLogger();
    const seen: unknown[] = [];
    const binder = createRouteBinder({
        authorizer: createAuthorizer({ clock: { nowMs: () => 0 }, policy: DASHBOARD_POLICY }),
        rateLimiter: { consume: () => Promise.resolve(options.limit ?? 'allowed') },
        logger,
        resolveSession: (token) => Promise.resolve(token === TOKEN ? (options.session ?? null) : null),
        authenticateRelay: () => Promise.resolve(null),
        signatures: { 'stripe-signature': () => Promise.resolve({ kind: 'invalid' }) },
    });
    const router = new Hono();
    binder.bind(router, '/api', renameEngine, ({ input }) => {
        seen.push(input);
        return Promise.resolve(
            input.body.name === 'missing'
                ? { kind: 'problem', status: 404, code: 'engine-not-found' }
                : { kind: 'ok', body: { name: input.body.name }, setCookies: ['a=1', 'b=2'] },
        );
    });
    binder.bind(router, '/api', sessionRoute, ({ session }) =>
        Promise.resolve({ kind: 'ok', body: { userId: session.user.id } }),
    );
    return { app: new Hono().route('/api', router), seen, logger, binder };
}

function post(app: Hono, path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return Promise.resolve(
        app.request(path, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } }),
    );
}

const signedRoute = defineRoute({
    method: 'POST',
    path: '/webhooks/test',
    auth: 'stripe-signature',
    permission: null,
    rateLimit: 'webhook-ip',
    input: {
        params: null,
        query: null,
        headers: z.strictObject({ 'stripe-signature': z.string().max(64) }),
        body: z.strictObject({ id: z.string() }),
        maxBodyBytes: 64,
    },
    output: z.strictObject({ id: z.string() }),
    errorCodes: ['invalid-signature'],
});

/** A route signed like Stripe's: the verifier accepts the bytes `{"id":"evt"}` signed `good` and returns `payload`. */
function signedHarness(payload: unknown = { id: 'evt' }) {
    const verified: { bytes: string; signature: string }[] = [];
    const seen: unknown[] = [];
    const binder = createRouteBinder({
        authorizer: createAuthorizer({ clock: { nowMs: () => 0 }, policy: DASHBOARD_POLICY }),
        rateLimiter: { consume: () => Promise.resolve('allowed') },
        logger: createMemoryLogger(),
        resolveSession: () => Promise.reject(new Error('signed routes never read a session')),
        authenticateRelay: () => Promise.reject(new Error('signed routes never read a relay key')),
        signatures: {
            'stripe-signature': (bytes, signature) => {
                verified.push({ bytes: new TextDecoder().decode(bytes), signature });
                return Promise.resolve(signature === 'good' ? { kind: 'verified', payload } : { kind: 'invalid' });
            },
        },
    });
    const router = new Hono();
    binder.bind(router, '/webhooks', signedRoute, ({ input, session }) => {
        seen.push({ input, session });
        return Promise.resolve({ kind: 'ok', body: { id: input.body.id } });
    });
    return { app: new Hono().route('/webhooks', router), verified, seen };
}

const session = (overrides: Partial<Actor> = {}) => ({ user: { id: USER }, actor: actor(overrides) }) as ActiveSession;

describe('route binder', () => {
    it('passes validated params, query, declared headers and body to the handler', async () => {
        const { app, seen } = harness();
        const response = await post(app, `/api/engines/${ENGINE}/name?dryRun=true`, '{"name":"Office"}', {
            'X-Request-Kind': 'rename',
            'X-Other': 'ignored',
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ name: 'Office' });
        expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
        expect(seen).toEqual([
            {
                params: { engineId: ENGINE },
                query: { dryRun: 'true' },
                headers: { 'x-request-kind': 'rename' },
                body: { name: 'Office' },
            },
        ]);
    });

    it('answers a declared error code as problem+json', async () => {
        const response = await post(harness().app, `/api/engines/${ENGINE}/name`, '{"name":"missing"}');
        expect(response.status).toBe(404);
        expect(response.headers.get('Content-Type')).toBe('application/problem+json');
        expect(await response.json()).toMatchObject({ status: 404, code: 'engine-not-found' });
    });

    it.each([
        ['a bad param', `/api/engines/NOT-AN-ID/name`, '{"name":"Office"}', {}],
        ['an unknown query field', `/api/engines/${ENGINE}/name?debug=1`, '{"name":"Office"}', {}],
        ['a bad declared header', `/api/engines/${ENGINE}/name`, '{"name":"Office"}', { 'X-Request-Kind': '<script>' }],
        ['an unknown body field', `/api/engines/${ENGINE}/name`, '{"name":"Office","isAdmin":true}', {}],
        ['malformed JSON', `/api/engines/${ENGINE}/name`, '{"name":<script>', {}],
        ['invalid UTF-8', `/api/engines/${ENGINE}/name`, '�', {}],
    ])('rejects %s before the handler runs, without echoing input', async (_, path, body, headers) => {
        const { app, seen } = harness();
        const response = await post(app, path, body, headers);
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({ status: 400, code: 'invalid-request' });
        expect(text).not.toContain('script');
        expect(text).not.toContain('isAdmin');
        expect(seen).toEqual([]);
    });

    it('refuses a body over the cap, declared or actual, with 413', async () => {
        const { app, seen } = harness();
        const big = JSON.stringify({ name: 'x'.repeat(300) });
        expect((await post(app, `/api/engines/${ENGINE}/name`, big)).status).toBe(413);
        const lying = await app.request(`/api/engines/${ENGINE}/name`, {
            method: 'POST',
            body: big,
            headers: { 'Content-Length': '10' },
        });
        expect(lying.status).toBe(413);
        const announced = await app.request(`/api/engines/${ENGINE}/name`, {
            method: 'POST',
            body: '{"name":"x"}',
            headers: { 'Content-Length': '1000000' },
        });
        expect(announced.status).toBe(413);
        expect(seen).toEqual([]);
    });

    it('stops reading a chunked body as soon as it passes the cap, and cancels the stream', async () => {
        const { app, seen } = harness();
        let pulled = 0;
        let cancelled = false;
        // Endless and without Content-Length: buffering it whole would never finish.
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled++;
                controller.enqueue(new Uint8Array(100).fill(0x20));
            },
            cancel() {
                cancelled = true;
            },
        });
        const response = await app.request(`/api/engines/${ENGINE}/name`, {
            method: 'POST',
            body,
            duplex: 'half',
        } as RequestInit);
        expect(response.status).toBe(413);
        expect(cancelled).toBe(true);
        // 256-byte cap, 100-byte chunks: the third chunk crosses it; the stream may have queued one more.
        expect(pulled).toBeLessThanOrEqual(4);
        expect(seen).toEqual([]);
    });

    it('treats a missing body as invalid JSON', async () => {
        const { app, seen } = harness();
        expect((await app.request(`/api/engines/${ENGINE}/name`, { method: 'POST' })).status).toBe(400);
        expect(seen).toEqual([]);
    });

    it.each(['abc', '-1', '1e3', ''])('refuses a malformed Content-Length %j with 400', async (length) => {
        const { app, seen } = harness();
        const response = await app.request(`/api/engines/${ENGINE}/name`, {
            method: 'POST',
            body: '{"name":"x"}',
            headers: { 'Content-Length': length },
        });
        expect(response.status).toBe(400);
        expect(seen).toEqual([]);
    });

    it('applies the route’s rate limit before anything else and fails closed when the limiter cannot decide', async () => {
        const limited = harness({ limit: 'limited' });
        expect((await post(limited.app, `/api/engines/${ENGINE}/name`, '{"name":"x"}')).status).toBe(429);
        const broken = harness({ limit: 'unavailable' });
        const response = await post(broken.app, `/api/engines/${ENGINE}/name`, '{"name":"x"}');
        expect(response.status).toBe(429);
        expect(broken.logger.entries).toEqual([
            { level: 'error', event: 'rate-limit.unavailable', fields: { rule: 'public-read-ip' } },
        ]);
        expect(broken.seen).toEqual([]);
    });

    it('requires a valid session cookie on session routes', async () => {
        const { app } = harness({ session: session() });
        const none = await app.request('/api/me');
        expect(none.status).toBe(401);
        expect(none.headers.getSetCookie()[0]).toMatch(/^__Host-ptbk_session=; Max-Age=0/);
        expect((await app.request('/api/me', { headers: { Cookie: `__Host-ptbk_session=short` } })).status).toBe(401);
        const ok = await app.request('/api/me', { headers: { Cookie: `__Host-ptbk_session=${TOKEN}` } });
        expect(await ok.json()).toEqual({ userId: USER });
    });

    it('authorizes the permission on the actor’s own scope and hides what is not theirs as 404', async () => {
        const binder = createRouteBinder({
            authorizer: {
                can: (_, action) =>
                    action === 'account.read'
                        ? { kind: 'denied', reason: 'not-self' }
                        : action === 'org.read'
                          ? { kind: 'denied', reason: 'recovery-cooldown' }
                          : { kind: 'denied', reason: 'role' },
            },
            rateLimiter: { consume: () => Promise.resolve('allowed') },
            logger: createMemoryLogger(),
            resolveSession: () => Promise.resolve(session()),
            authenticateRelay: () => Promise.resolve(null),
            signatures: { 'stripe-signature': () => Promise.resolve({ kind: 'invalid' }) },
        });
        const router = new Hono();
        const handler: RouteHandler<RouteContract> = () => Promise.resolve({ kind: 'ok', body: {} });
        const routeFor = (path: `/api/${string}`, permission: string) =>
            ({ ...sessionRoute, path, permission, output: z.strictObject({}) }) as RouteContract;
        binder.bind(router, '/api', routeFor('/api/a', 'account.read'), handler);
        binder.bind(router, '/api', routeFor('/api/b', 'org.read'), handler);
        binder.bind(router, '/api', routeFor('/api/c', 'passkey.manage'), handler);
        const app = new Hono().route('/api', router);
        const cookie = { headers: { Cookie: `__Host-ptbk_session=${TOKEN}` } };
        expect(await (await app.request('/api/a', cookie)).json()).toMatchObject({ status: 404, code: 'not-found' });
        expect(await (await app.request('/api/b', cookie)).json()).toMatchObject({
            status: 403,
            code: 'recovery-cooldown',
        });
        expect(await (await app.request('/api/c', cookie)).json()).toMatchObject({ status: 403, code: 'forbidden' });
        expect(binder.routes.map((route) => route.path)).toEqual(['/api/a', '/api/b', '/api/c']);
    });

    it.each<[string, Partial<RouteContract>]>([
        ['a session route without permission', { auth: 'session', permission: null, rateLimit: null }],
        ['a session route with an unknown permission', { auth: 'session', permission: 'root', rateLimit: null }],
        ['a public route without rate limit', { auth: 'public', permission: null, rateLimit: null }],
        [
            'a public route with an email-keyed limit',
            { auth: 'public', permission: null, rateLimit: 'signup-start-email' },
        ],
        [
            'an unknown rate limit on a session route',
            { auth: 'session', permission: 'account.read', rateLimit: 'nope' },
        ],
        ['a body without a size cap', { input: { ...NO_INPUT, body: z.strictObject({}) } }],
        ['path parameters without a schema', { path: '/api/engines/:engineId' }],
        ['a path outside the mount', { path: '/v1/me' }],
        [
            'a signed route without a body schema',
            { auth: 'stripe-signature', permission: null, rateLimit: 'webhook-ip' },
        ],
        [
            'an engine-signed route without a body schema',
            { auth: 'engine-signature', permission: null, rateLimit: 'registration-ip' },
        ],
        ['a relay route without rate limit', { auth: 'relay-token', permission: null, rateLimit: null }],
        ['a relay route with a per-IP limit', { auth: 'relay-token', permission: null, rateLimit: 'public-read-ip' }],
        ['a public route with a per-relay limit', { auth: 'public', permission: null, rateLimit: 'registry-relay' }],
        [
            'a signed route without rate limit',
            {
                auth: 'stripe-signature',
                permission: null,
                rateLimit: null,
                input: { ...signedRoute.input },
            },
        ],
    ])('refuses to mount %s', (_, change) => {
        const binder = harness().binder;
        const contract: RouteContract = { ...sessionRoute, ...change };
        expect(() => {
            binder.bind(new Hono(), '/api', contract, () => Promise.resolve({ kind: 'ok', body: {} }));
        }).toThrow(/refusing to mount/);
    });

    describe('signed routes', () => {
        const send = (app: Hono, body: string, headers: Record<string, string> = {}) =>
            app.request('/webhooks/test', { method: 'POST', body, headers });

        it('verifies the exact bytes before parsing, then hands the verified payload to the handler', async () => {
            const { app, verified, seen } = signedHarness();
            const raw = '{"id":"evt"}\n';
            const response = await send(app, raw, {
                'Stripe-Signature': 'good',
                Cookie: `__Host-ptbk_session=${TOKEN}`,
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ id: 'evt' });
            expect(verified).toEqual([{ bytes: raw, signature: 'good' }]);
            expect(seen).toEqual([
                {
                    input: {
                        params: undefined,
                        query: undefined,
                        headers: { 'stripe-signature': 'good' },
                        body: { id: 'evt' },
                    },
                    session: null,
                },
            ]);
        });

        it('answers 400 invalid-signature without or with a bad signature, before the handler runs', async () => {
            const { app, seen } = signedHarness();
            for (const headers of [{}, { 'Stripe-Signature': 'forged' }]) {
                const response = await send(app, '{"id":"evt"}', headers);
                expect(response.status).toBe(400);
                expect(await response.json()).toMatchObject({ code: 'invalid-signature' });
            }
            expect(seen).toEqual([]);
        });

        it('never verifies a body over the cap, and rejects a verified payload its schema refuses', async () => {
            const big = signedHarness();
            expect((await send(big.app, 'x'.repeat(65), { 'Stripe-Signature': 'good' })).status).toBe(413);
            expect(big.verified).toEqual([]);
            const odd = signedHarness({ id: 'evt', extra: true });
            const response = await send(odd.app, '{}', { 'Stripe-Signature': 'good' });
            expect(await response.json()).toMatchObject({ status: 400, code: 'invalid-request' });
            expect(odd.seen).toEqual([]);
        });
    });

    describe('relay routes', () => {
        const relayRoute = defineRoute({
            method: 'GET',
            path: '/internal/things/:id',
            auth: 'relay-token',
            permission: null,
            rateLimit: 'registry-relay',
            input: { ...NO_INPUT, params: z.strictObject({ id: z.string().regex(/^[a-z]{1,8}$/) }) },
            output: z.strictObject({ relayId: z.string() }),
            errorCodes: [],
        });

        function relayHarness(limit: RateLimitOutcome = 'allowed') {
            const consumed: [string, string][] = [];
            const deferred: Promise<unknown>[] = [];
            const binder = createRouteBinder({
                authorizer: createAuthorizer({ clock: { nowMs: () => 0 }, policy: DASHBOARD_POLICY }),
                rateLimiter: {
                    consume: (rule, key) => {
                        consumed.push([rule, key]);
                        return Promise.resolve(limit);
                    },
                },
                logger: createMemoryLogger(),
                resolveSession: () => Promise.reject(new Error('relay routes never read a session')),
                authenticateRelay: (authorization, defer) => {
                    defer(Promise.resolve('touched'));
                    return Promise.resolve(
                        authorization === 'Bearer good'
                            ? { tokenId: relayTokenIdSchema.parse('r'.repeat(26)), relayId: 'relay-1.ptbk.test' }
                            : null,
                    );
                },
                signatures: { 'stripe-signature': () => Promise.resolve({ kind: 'invalid' }) },
            });
            const router = new Hono();
            binder.bind(router, '/internal', relayRoute, ({ relay }) =>
                Promise.resolve({ kind: 'ok', body: { relayId: relay.relayId } }),
            );
            const app = new Hono().route('/internal', router);
            const executionCtx = {
                waitUntil: (task: Promise<unknown>) => deferred.push(task),
                passThroughOnException: () => undefined,
                props: {},
            } as unknown as ExecutionContext;
            const get = (path: string, headers: Record<string, string> = {}) =>
                app.request(path, { headers }, undefined, executionCtx);
            return { get, consumed, deferred };
        }

        it('authenticates before anything else and counts the budget per relay', async () => {
            const { get, consumed, deferred } = relayHarness();
            const refused = await get('/internal/things/NOPE');
            expect(refused.status).toBe(401);
            expect(await refused.json()).toMatchObject({ code: 'unauthorized' });
            expect(consumed).toEqual([]);
            const malformed = await get('/internal/things/NOPE', { Authorization: 'Bearer good' });
            expect(malformed.status).toBe(400);
            const ok = await get('/internal/things/abc', { Authorization: 'Bearer good' });
            expect(await ok.json()).toEqual({ relayId: 'relay-1.ptbk.test' });
            expect(consumed).toEqual([
                ['registry-relay', 'relay-1.ptbk.test'],
                ['registry-relay', 'relay-1.ptbk.test'],
            ]);
            expect(deferred).toHaveLength(3);
        });

        it('answers 429 once the relay is over its budget, and when the limiter cannot decide', async () => {
            for (const outcome of ['limited', 'unavailable'] as const) {
                const response = await relayHarness(outcome).get('/internal/things/abc', {
                    Authorization: 'Bearer good',
                });
                expect(response.status).toBe(429);
            }
        });
    });
});
