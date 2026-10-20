import type { TLSSocket } from 'node:tls';

import {
    ENGINE_API_PREFIX,
    ENGINE_API_ROUTE_LIST,
    ENGINE_RESERVED_PATHS,
    ENGINE_UI_CSP,
    SIGN_IN_PATH,
    SIGN_OUT_PATH,
    STEP_UP_PATH,
} from '@ptbk/engine-api';
import { createInMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createInTunnelRoutes } from '../../app/start-mock-engine';
import { NO_FAULTS } from '../../domain/faults/fault-plan';
import { createSessionStore } from '../../domain/gateway/sessions';
import type { RateLimiter } from '../../domain/rate-limit/rate-limiter';
import { isRateLimitRule } from '../../domain/rate-limit/rate-limiter';
import type { EngineHarness, HarnessResponse } from '../../testing/engine-harness';
import { HARNESS_ENGINE_ID, HARNESS_HOSTNAME, createEngineHarness } from '../../testing/engine-harness';
import { createEngineRuntime } from '../../domain/state/engine-runtime';
import { createFakeClock } from '../../testing/fake-clock';
import { createMemoryLogger } from '../../testing/memory-logger';
import { createSeededRandom } from '../../testing/seeded-random';
import { createControlRoutes, createFaultSettings } from '../control-server';
import { BASELINE_HEADERS, createHttpApp } from './http-app';
import type { Route } from './route';
import { defineHttpRoute, defineWebSocketRoute } from './route';
import { createSpikeRoutes } from './spike-routes';

let harness: EngineHarness | undefined;
afterEach(() => {
    harness?.close();
    harness = undefined;
});

function start(options: Parameters<typeof createEngineHarness>[0] = {}): EngineHarness {
    harness = createEngineHarness(options);
    return harness;
}

function expectBaselineHeaders(response: HarnessResponse): void {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe(ENGINE_UI_CSP);
}

function problemOf(response: HarnessResponse): unknown {
    expect(response.headers['content-type']).toBe('application/problem+json');
    return JSON.parse(response.body.toString('utf8'));
}

/** Sends raw HTTP/1.1 over a fresh TLS connection and returns everything the server sent until it ended. */
async function raw(engine: EngineHarness, text: string): Promise<string> {
    const socket: TLSSocket = await engine.connect();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    // The client end stays half-open (it inherits the duplex pair's allowHalfOpen), so wait for the server's end.
    const ended = new Promise((resolve) => socket.once('end', resolve));
    socket.write(text);
    await ended;
    socket.destroy();
    return Buffer.concat(chunks).toString('utf8');
}

const SPIKE_ROUTES = [
    'http GET /',
    'http GET /__spike/',
    'http GET /__spike/whoami',
    'http GET /__spike/sse',
    'http GET /__spike/download',
    'websocket GET /__spike/ws',
    'websocket GET /__spike/screencast',
] as const;

/** Session routes that act only on the caller's own credentials, or on nothing, and so declare no permission. */
const SELF_SCOPED_SESSION_ROUTES = [
    `${ENGINE_API_PREFIX}/me`,
    `${ENGINE_API_PREFIX}/me/**`,
    `${ENGINE_API_PREFIX}/engine`,
    `POST ${SIGN_OUT_PATH}`,
    `GET ${STEP_UP_PATH}`,
    `POST ${STEP_UP_PATH}`,
] as const;

function selfScoped(route: Route): boolean {
    return SELF_SCOPED_SESSION_ROUTES.some((entry) => {
        if (entry.startsWith('/')) {
            return entry.endsWith('/**') ? route.path.startsWith(entry.slice(0, -2)) : route.path === entry;
        }
        return entry === `${route.method} ${route.path}`;
    });
}

const key = (route: Route): string => `${route.transport} ${route.method} ${route.path}`;

function inTunnelRoutes(devLogin: boolean): readonly Route[] {
    const core = createInMemoryEngineCore({ capabilities: [] });
    const clock = createFakeClock();
    return createInTunnelRoutes({
        engineId: HARNESS_ENGINE_ID,
        clock,
        core: () => core,
        sessions: createSessionStore({ engine: () => core.controller, clock, random: createSeededRandom(1) }),
        devLogin,
    });
}

function controlRoutes(): readonly Route[] {
    const clock = createFakeClock();
    const runtime = createEngineRuntime({
        seed: 1,
        scenario: 'empty',
        epoch: new Date('2026-10-01T00:00:00Z'),
        identity: { engineId: HARNESS_ENGINE_ID, hostname: HARNESS_HOSTNAME, mode: 'tunnel', version: '0.1.0' },
        clock,
    });
    return createControlRoutes({
        runtime,
        sessions: createSessionStore({ engine: () => runtime.controller(), clock, random: createSeededRandom(1) }),
        faults: createFaultSettings(NO_FAULTS),
        rateLimiter: { consume: () => ({ kind: 'allowed' }) },
        logger: createMemoryLogger(),
        now: () => '2026-10-01T00:00:00Z',
    });
}

function expectStrictInput(route: Route): void {
    expect(isRateLimitRule(route.rateLimit), key(route)).toBe(true);
    expect(route.query.safeParse({ unexpected: '1' }).success, key(route)).toBe(false);
    if (route.headers !== null) expect(route.headers.safeParse({ unexpected: '1' }).success, key(route)).toBe(false);
    if (route.params !== null) {
        expect(route.params.safeParse({ unexpected: '1' }).success, key(route)).toBe(false);
        for (const name of [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '')) {
            expect(Object.keys(route.params.shape), key(route)).toContain(name);
        }
    } else {
        expect(route.path, key(route)).not.toMatch(/\{/);
    }
}

describe.each([
    ['with dev login', true],
    ['without dev login', false],
])('route table %s', (_name, devLogin) => {
    const routes = createHttpApp({
        routes: inTunnelRoutes(devLogin),
        rateLimiter: { consume: () => ({ kind: 'allowed' }) },
        logger: createMemoryLogger(),
        sessions: createSessionStore({
            engine: () => createInMemoryEngineCore().controller,
            clock: createFakeClock(),
            random: createSeededRandom(1),
        }),
    }).routes;

    it('declares an auth mode, a rate limit and strict input on every route', () => {
        for (const route of routes) {
            expect(['public', 'session'], key(route)).toContain(route.auth);
            expectStrictInput(route);
        }
    });

    it('mounts exactly the allowlisted public routes', () => {
        const expected = [
            ...SPIKE_ROUTES,
            `http GET ${SIGN_IN_PATH}`,
            ...(devLogin ? [`http POST ${SIGN_IN_PATH}`] : []),
        ];
        expect(
            routes
                .filter((route) => route.auth === 'public')
                .map(key)
                .sort(),
        ).toEqual([...expected].sort());
        for (const route of routes.filter((candidate) => candidate.auth === 'public')) {
            expect(route.permission, key(route)).toBeNull();
        }
    });

    it('gives every session route a permission, except the self-scoped allowlist', () => {
        for (const route of routes.filter((candidate) => candidate.auth === 'session')) {
            if (selfScoped(route)) expect(route.permission, key(route)).toBeNull();
            else expect(route.permission, key(route)).not.toBeNull();
        }
        const stepUp = routes.filter((route) => route.path === STEP_UP_PATH).map((route) => route.method);
        expect(stepUp.sort()).toEqual(devLogin ? ['GET', 'POST'] : []);
    });

    it('serves exactly the engine API route table under the API prefix', () => {
        const api = routes.filter((route) => route.path.startsWith('/api/'));
        expect(api.map((route) => [route.method, route.path, route.permission, route.auth])).toEqual(
            ENGINE_API_ROUTE_LIST.map((route) => [
                route.method,
                `${ENGINE_API_PREFIX}${route.path}`,
                route.permission,
                'session',
            ]),
        );
    });

    it('keeps everything else off the reserved paths, except the gateway under /auth/', () => {
        for (const route of routes) {
            const reserved = ENGINE_RESERVED_PATHS.find((prefix) => route.path.startsWith(prefix));
            if (reserved === undefined) continue;
            expect(['/api/', '/auth/'], key(route)).toContain(reserved);
        }
    });

    it('never mounts a control route in the tunnel', () => {
        const mounted = new Set(routes.map((route) => route.path));
        expect(controlRoutes().filter((route) => mounted.has(route.path))).toEqual([]);
        expect(routes.some((route) => route.path.startsWith('/__mock'))).toBe(false);
    });
});

describe('control listener route table', () => {
    it('declares only control routes under /__mock/, each with a rate limit and strict input', () => {
        const routes = controlRoutes();
        expect(routes.map(key).sort()).toEqual(
            [
                'http DELETE /__mock/faults',
                'http GET /__mock/members',
                'http GET /__mock/state',
                'http POST /__mock/reset',
                'http POST /__mock/sessions',
                'http PUT /__mock/faults',
            ].sort(),
        );
        for (const route of routes) {
            expect(route.auth).toBe('control');
            expect(route.permission).toBeNull();
            expect(route.path.startsWith('/__mock/')).toBe(true);
            expectStrictInput(route);
            if (route.transport === 'http' && route.body !== null) {
                expect(route.body.schema.safeParse({ unexpected: '1' }).success, key(route)).toBe(false);
            }
        }
    });
});

describe('mounting', () => {
    const app = (routes: readonly Route[], withSessions = false) =>
        createHttpApp({
            routes,
            rateLimiter: { consume: () => ({ kind: 'allowed' }) },
            logger: createMemoryLogger(),
            ...(withSessions
                ? {
                      sessions: createSessionStore({
                          engine: () => createInMemoryEngineCore().controller,
                          clock: createFakeClock(),
                          random: createSeededRandom(1),
                      }),
                  }
                : {}),
        });

    it('refuses to mount the same route twice', () => {
        const [first] = createSpikeRoutes({ engineId: HARNESS_ENGINE_ID, clock: createFakeClock() });
        if (first === undefined) throw new Error('no routes');
        expect(() => app([first, first])).toThrow('refusing to mount http GET / twice');
    });

    it('refuses a control route', () => {
        const [route] = controlRoutes();
        if (route === undefined) throw new Error('no routes');
        expect(() => app([route], true)).toThrow(/refusing to mount control route/);
    });

    it('refuses a session route without a gateway', () => {
        const route = inTunnelRoutes(false).find((candidate) => candidate.auth === 'session');
        if (route === undefined) throw new Error('no routes');
        expect(() => app([route])).toThrow(/without a gateway/);
        expect(() => app([route], true)).not.toThrow();
    });
});

describe('responses', () => {
    it('carry the baseline headers on pages, JSON, 400 and 404', async () => {
        const engine = start();
        for (const path of [
            '/',
            '/__spike/whoami',
            '/__spike/sse?count=nope',
            '/nowhere',
            '/__spike/download?bytes=1',
        ]) {
            expectBaselineHeaders(await engine.get(path));
        }
        expect(Object.keys(BASELINE_HEADERS)).toHaveLength(3);
    });

    it('answers whoami with the engine, SNI hostname, client IP from OPEN, ALPN and TLS version', async () => {
        const response = await start().get('/__spike/whoami', { clientIp: '192.0.2.44' });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.toString('utf8'))).toEqual({
            engineId: HARNESS_ENGINE_ID,
            hostname: HARNESS_HOSTNAME,
            clientIp: '192.0.2.44',
            alpn: 'http/1.1',
            tlsVersion: 'TLSv1.3',
        });
    });

    it('answers an unknown path with a 404 problem', async () => {
        const response = await start().get('/__spike/nowhere');
        expect(response.status).toBe(404);
        expect(problemOf(response)).toMatchObject({ status: 404, code: 'not-found' });
    });

    it('turns a handler exception into a 500 problem without internals, and logs only its name', async () => {
        const engine = start({
            routes: [
                defineHttpRoute({
                    transport: 'http',
                    params: null,
                    body: null,
                    method: 'GET',
                    path: '/boom',
                    auth: 'public',
                    permission: null,
                    rateLimit: 'spike-ip',
                    query: z.strictObject({}),
                    headers: null,
                    handle: () => {
                        throw new TypeError('secret detail /etc/passwd');
                    },
                }),
            ],
        });
        const response = await engine.get('/boom');
        expect(response.status).toBe(500);
        expectBaselineHeaders(response);
        expect(problemOf(response)).toMatchObject({ status: 500, code: 'internal-error' });
        expect(response.body.toString('utf8')).not.toContain('secret detail');
        expect(engine.logger.entries).toContainEqual({
            level: 'error',
            event: 'http.error',
            fields: { problem: 'TypeError' },
        });
        expect(engine.logger.text()).not.toContain('secret detail');
    });
});

describe('rate limits', () => {
    const limited: RateLimiter = { consume: () => ({ kind: 'limited', retryAfterMs: 1_500 }) };

    it('answers 429 with Retry-After in whole seconds', async () => {
        const response = await start({ rateLimiter: limited }).get('/__spike/whoami');
        expect(response.status).toBe(429);
        expect(response.headers['retry-after']).toBe('2');
        expectBaselineHeaders(response);
        expect(problemOf(response)).toMatchObject({ code: 'rate-limited' });
    });

    it('refuses a WebSocket upgrade with 429', async () => {
        const engine = start({ rateLimiter: limited });
        await expect(engine.webSocket('/__spike/ws')).rejects.toThrow('unexpected response 429');
        const response = await raw(
            engine,
            `GET /__spike/ws HTTP/1.1\r\nHost: ${HARNESS_HOSTNAME}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
        expect(response).toMatch(/^HTTP\/1\.1 429 Too Many Requests\r\n/);
        expect(response).toContain('\r\nRetry-After: 2\r\n');
        expect(response).toContain(`\r\nContent-Security-Policy: ${ENGINE_UI_CSP}\r\n`);
    });

    it('counts per client IP from the tunnel, with the route’s policy', async () => {
        const calls: string[] = [];
        const engine = start({
            rateLimiter: {
                consume: (rule, key) => {
                    calls.push(`${rule} ${key}`);
                    return { kind: 'allowed' };
                },
            },
        });
        await engine.get('/__spike/whoami', { clientIp: '192.0.2.1' });
        await engine.get('/__spike/download?bytes=1', { clientIp: '192.0.2.2' });
        (await engine.webSocket('/__spike/ws', { clientIp: '192.0.2.3' })).close();
        expect(calls).toEqual(['spike-ip 192.0.2.1', 'spike-bulk-ip 192.0.2.2', 'spike-ip 192.0.2.3']);
    });
});

describe('WebSocket upgrades', () => {
    const upgrade = (method: string, path: string) =>
        `${method} ${path} HTTP/1.1\r\nHost: ${HARNESS_HOSTNAME}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';

    it('answers an unknown path with a 404 problem', async () => {
        const engine = start();
        await expect(engine.webSocket('/__spike/nowhere')).rejects.toThrow('unexpected response 404');
        const response = await raw(engine, upgrade('GET', '/__spike/whoami'));
        expect(response).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
        expect(response).toContain('application/problem+json');
        expect(response).toContain('"code":"not-found"');
    });

    it('validates the headers a WebSocket route declares', async () => {
        const engine = start({
            routes: [
                defineWebSocketRoute({
                    transport: 'websocket',
                    params: null,
                    method: 'GET',
                    path: '/needs-header',
                    auth: 'public',
                    permission: null,
                    rateLimit: 'spike-ip',
                    query: z.strictObject({}),
                    headers: z.strictObject({ 'x-mode': z.literal('test') }),
                    maxPayloadBytes: 1024,
                    handle: (socket) => {
                        socket.close();
                    },
                }),
            ],
        });
        const missing = await raw(engine, upgrade('GET', '/needs-header'));
        expect(missing).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
        expect(missing).toContain('"path":"headers.x-mode"');
        const wrong = await raw(
            engine,
            upgrade('GET', '/needs-header').replace('\r\n\r\n', '\r\nX-Mode: other\r\n\r\n'),
        );
        expect(wrong).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    });

    it('refuses an upgrade with any method but GET', async () => {
        const response = await raw(start(), upgrade('POST', '/__spike/ws'));
        expect(response).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
    });
});

describe('connections', () => {
    it('are tracked until closed, and close() destroys the rest', async () => {
        const engine = start();
        const socket = await engine.webSocket('/__spike/ws');
        expect(engine.http.connections()).toBe(1);
        const closed = new Promise<number>((resolve) => socket.once('close', resolve));
        engine.http.close();
        await closed;
        expect(engine.http.connections()).toBe(0);
    });

    it('refuses a malformed request', async () => {
        const response = await raw(start(), 'NOT HTTP\r\n\r\n');
        expect(response).toBe('');
    });
});
