import { Timestamp, createCryptoRandom } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { NO_FAULTS } from '../domain/faults/fault-plan';
import { createSessionStore } from '../domain/gateway/sessions';
import type { HeartbeatStatus } from '../domain/heartbeat/heartbeat-loop';
import type { RateLimiter } from '../domain/rate-limit/rate-limiter';
import type { EngineRuntime } from '../domain/state/engine-runtime';
import { createTestRuntime } from '../testing/test-runtime';
import type { Scenario } from '../domain/state/scenarios';
import { createFakeClock } from '../testing/fake-clock';
import { createMemoryLogger } from '../testing/memory-logger';
import type { ControlServer } from './control-server';
import { createFaultSettings, startControlServer } from './control-server';

const servers: ControlServer[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

const ALLOW: RateLimiter = { consume: () => ({ kind: 'allowed' }) };

async function start(
    options: {
        scenario?: Scenario;
        rateLimiter?: RateLimiter;
        runtime?: (runtime: EngineRuntime) => EngineRuntime;
        heartbeat?: () => HeartbeatStatus;
    } = {},
) {
    const clock = createFakeClock(Date.parse('2026-10-01T00:00:00Z'));
    const base = await createTestRuntime({
        seed: 3,
        scenario: options.scenario ?? 'empty',
        epoch: new Date('2026-10-01T00:00:00Z'),
        identity: {
            engineId: 'abcdefghijklmnopqrstuvwxyz',
            hostname: 'abcdefghijklmnopqrstuvwxyz.engine.test',
            mode: 'tunnel',
            version: '0.1.0',
        },
        clock,
    });
    const runtime = options.runtime?.(base) ?? base;
    const logger = createMemoryLogger();
    const sessions = createSessionStore({ engine: () => base.controller(), clock, random: createCryptoRandom() });
    const server = await startControlServer({
        host: '127.0.0.1',
        port: 0,
        runtime,
        sessions,
        faults: createFaultSettings(NO_FAULTS),
        rateLimiter: options.rateLimiter ?? ALLOW,
        ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
        logger,
        now: () => '2026-10-01T00:00:00Z',
    });
    servers.push(server);
    const post = async (path: string, body: unknown) => {
        const response = await fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { response, body: (await response.json()) as Record<string, unknown> };
    };
    return { server, runtime: base, sessions, logger, post };
}

describe('fault settings', () => {
    it('hold the plan until it is replaced', () => {
        const settings = createFaultSettings(NO_FAULTS);
        expect(settings.plan()).toBe(NO_FAULTS);
        const next = { ...NO_FAULTS, errorRate: 0.5 };
        settings.set(next);
        expect(settings.plan()).toBe(next);
    });
});

describe('control server', () => {
    it('reports the heartbeat status, and nothing in the M1 dev mode', async () => {
        const status: HeartbeatStatus = {
            lastHeartbeat: {
                sentAt: Timestamp.parse('2026-10-01T00:00:00Z'),
                body: '{"v":1}',
                signature: 'ed25519=sig',
            },
            clockSkew: { seconds: -300, measuredAt: Timestamp.parse('2026-10-01T00:00:00Z') },
            lastAnswer: { kind: 'refused', status: 401 },
        };
        const linked = await start({ heartbeat: () => status });
        const response = await fetch(`http://127.0.0.1:${String(linked.server.port)}/__mock/heartbeat`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(status);
        const devMode = await start();
        const empty = await fetch(`http://127.0.0.1:${String(devMode.server.port)}/__mock/heartbeat`);
        expect(await empty.json()).toEqual({ lastHeartbeat: null, clockSkew: null, lastAnswer: null });
    });

    it('creates a synthetic member of the asked role when the scenario has none, numbering each one', async () => {
        const { runtime, post } = await start();
        const admin = await post('/__mock/sessions', { subject: { kind: 'member', role: 'admin' } });
        expect(admin.response.status).toBe(201);
        expect(admin.body['memberId']).toBe('member-synthetic-0001');
        const again = await post('/__mock/sessions', { subject: { kind: 'member', role: 'admin' } });
        expect(again.body['memberId']).toBe('member-synthetic-0001');
        const set = await post('/__mock/sessions', { subject: { kind: 'member', permissions: ['agents.read'] } });
        expect(set.body['memberId']).toBe('member-synthetic-0002');
        const members = runtime.controller().inspect().members;
        expect(members.find(({ id }) => id === 'member-synthetic-0001')).toMatchObject({
            role: 'admin',
            displayName: 'Synthetic admin 1',
            status: 'active',
            createdAt: '2026-10-01T00:00:00Z',
        });
        expect(members.find(({ id }) => id === 'member-synthetic-0002')).toMatchObject({ role: 'member' });
        const owner = await post('/__mock/sessions', { subject: { kind: 'owner' } });
        expect(members.find(({ role }) => role === 'owner')?.id).toBe(owner.body['memberId']);
    });

    it("lets every session's passkey assertion go stale, so the next step-up route asks again", async () => {
        const { server, sessions, post } = await start();
        const owner = await post('/__mock/sessions', { subject: { kind: 'owner' } });
        const token = (owner.body['cookie'] as { value: string }).value;
        const client = { ip: '198.51.100.9', userAgent: 'test' };
        const fresh = () => {
            const outcome = sessions.authenticate(token, client);
            return outcome.kind === 'signed-in' && outcome.actor.stepUpFresh;
        };
        expect(fresh()).toBe(true);
        const response = await fetch(`http://127.0.0.1:${String(server.port)}/__mock/step-up/expire`, {
            method: 'POST',
        });
        expect(response.status).toBe(204);
        expect(fresh()).toBe(false);
    });

    it('raises one Wallet request per origin and account, moving it to a new step on another problem', async () => {
        const { post } = await start();
        const first = await post('/__mock/wallet-requests', { origin: 'https://github.com' });
        expect(first.response.status).toBe(201);
        expect(first.body['request']).toMatchObject({ origin: 'https://github.com', problem: 'missing', step: 0 });
        const moved = await post('/__mock/wallet-requests', { origin: 'https://github.com', problem: 'rejected' });
        expect(moved.body['request']).toMatchObject({ requests: 2, step: 1 });
        const refused = await post('/__mock/wallet-requests', { origin: 'https://github.com/login' });
        expect(refused.response.status).toBe(400);
    });

    it('answers 429 with Retry-After when the rate limit refuses', async () => {
        const { server } = await start({
            rateLimiter: { consume: () => ({ kind: 'limited', retryAfterMs: 1500 }) },
        });
        const response = await fetch(`http://127.0.0.1:${String(server.port)}/__mock/state`);
        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('2');
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('turns an exception into a 500 problem and logs only its name', async () => {
        const { server, logger } = await start({
            runtime: (runtime) => ({
                ...runtime,
                controller: () => {
                    throw new TypeError('secret detail');
                },
            }),
        });
        const response = await fetch(`http://127.0.0.1:${String(server.port)}/__mock/state`);
        expect(response.status).toBe(500);
        expect(((await response.json()) as { code: string }).code).toBe('internal-error');
        expect(logger.entries).toContainEqual(
            expect.objectContaining({ event: 'control.error', fields: { problem: 'TypeError' } }),
        );
        expect(JSON.stringify(logger.entries)).not.toContain('secret detail');
    });

    it('declares only control routes, and reports where it listens', async () => {
        const { server, logger } = await start();
        expect(server.routes.every((route) => route.auth === 'control' && route.rateLimit === 'control')).toBe(true);
        expect(server.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
            'DELETE /__mock/faults',
            'GET /__mock/heartbeat',
            'GET /__mock/members',
            'GET /__mock/state',
            'GET /__mock/ui',
            'POST /__mock/inbound-email',
            'POST /__mock/reset',
            'POST /__mock/runs',
            'POST /__mock/sessions',
            'POST /__mock/simulation',
            'POST /__mock/simulation/advance',
            'POST /__mock/step-up/expire',
            'POST /__mock/ui/check',
            'POST /__mock/wallet-requests',
            'PUT /__mock/faults',
        ]);
        expect(logger.entries).toContainEqual(
            expect.objectContaining({ event: 'control.listening', fields: { host: '127.0.0.1', port: server.port } }),
        );
    });

    it('refuses to start on a port that is taken', async () => {
        const { server } = await start();
        await expect(
            startControlServer({
                host: '127.0.0.1',
                port: server.port,
                runtime: (await start()).runtime,
                sessions: createSessionStore({
                    engine: () => {
                        throw new Error('unused');
                    },
                    clock: createFakeClock(),
                    random: createCryptoRandom(),
                }),
                faults: createFaultSettings(NO_FAULTS),
                rateLimiter: ALLOW,
                logger: createMemoryLogger(),
                now: () => '2026-10-01T00:00:00Z',
            }),
        ).rejects.toThrow();
    });
});
