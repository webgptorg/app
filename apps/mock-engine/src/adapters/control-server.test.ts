import {
    BrowserTabId,
    ClientInfo,
    MemberId,
    OWNER_PERMISSIONS,
    SessionId,
    createEngineApiClient,
} from '@ptbk/engine-api';
import type { EngineApiClient, OnboardingAnswer } from '@ptbk/engine-api';
import { CHECK_MS } from '@ptbk/engine-api/in-memory';
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
        liveBrowser?: boolean;
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
        ...(options.liveBrowser === undefined ? {} : { liveBrowser: options.liveBrowser }),
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

function ownerClient(runtime: EngineRuntime): EngineApiClient {
    const owner = runtime
        .controller()
        .inspect()
        .members.find(({ role }) => role === 'owner');
    if (owner === undefined) throw new Error('no owner');
    return createEngineApiClient(
        runtime.core().transport({
            memberId: MemberId.parse(owner.id),
            sessionId: SessionId.parse('session-test'),
            client: ClientInfo.parse({ ip: '127.0.0.1', userAgent: 'control test' }),
            permissions: new Set(OWNER_PERMISSIONS),
            stepUpFresh: true,
        }),
    );
}

async function answerSetup(client: EngineApiClient, answer: OnboardingAnswer): Promise<void> {
    const signal = AbortSignal.timeout(5_000);
    const state = await client.onboarding.get(signal);
    if (state.kind !== 'ok' || state.data.prompt === null) throw new Error('no setup prompt');
    const answered = await client.onboarding.answer(
        { promptId: state.data.prompt.id, action: 'answer', answer },
        signal,
    );
    if (answered.kind !== 'ok') throw new Error(answered.problem.code);
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

    it('signs a session in with a stale passkey assertion when asked', async () => {
        const { sessions, post } = await start();
        const stepUpOf = async (body: object) => {
            const created = await post('/__mock/sessions', { subject: { kind: 'owner' }, ...body });
            const outcome = sessions.authenticate((created.body['cookie'] as { value: string }).value, {
                ip: '198.51.100.9',
                userAgent: 'test',
            });
            return outcome.kind === 'signed-in' && outcome.actor.stepUpFresh;
        };
        expect(await stepUpOf({})).toBe(true);
        expect(await stepUpOf({ stepUp: 'fresh' })).toBe(true);
        expect(await stepUpOf({ stepUp: 'stale' })).toBe(false);
        expect((await post('/__mock/sessions', { subject: { kind: 'owner' }, stepUp: 'old' })).response.status).toBe(
            400,
        );
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

    it('settles the running harness sign-in and fails a harness check, as the provider would', async () => {
        const { post, runtime } = await start();
        const client = ownerClient(runtime);
        const nothingRunning = await post('/__mock/onboarding/harness-login', { outcome: 'denied' });
        expect(nothingRunning.response.status).toBe(400);
        const unknownTool = await post('/__mock/onboarding/harness-check', { harness: 'cursor', reason: 'x' });
        expect(unknownTool.response.status).toBe(400);
        const failing = await post('/__mock/onboarding/harness-check', {
            harness: 'claude',
            reason: 'This account has no Claude Code access.',
        });
        expect(failing.response.status).toBe(200);

        await answerSetup(client, { kind: 'text', text: 'Books', fileIds: [] });
        await answerSetup(client, { kind: 'choice', choiceIds: ['claude'] });
        const denied = await post('/__mock/onboarding/harness-login', { outcome: 'denied', diagnostic: 'Not here.' });
        expect(denied.body['prompt']).toMatchObject({
            kind: 'harness-login',
            status: 'denied',
            diagnostic: 'Not here.',
        });
        await answerSetup(client, { kind: 'harness-login', returnCode: null });
        const settled = await post('/__mock/onboarding/harness-login', { outcome: 'succeeded' });
        expect(settled.body).toMatchObject({ status: 'working', prompt: null });

        runtime.clock.advance(CHECK_MS);
        expect(runtime.controller().onboarding()).toMatchObject({
            status: 'pending',
            prompt: { kind: 'choice' },
            activity: [
                { id: 'install-claude', status: 'skipped' },
                { id: 'check-claude', status: 'failed', detail: 'This account has no Claude Code access.' },
            ],
        });
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
            'POST /__mock/live-browser/elapse',
            'POST /__mock/live-browser/help-requests',
            'POST /__mock/live-browser/navigate',
            'POST /__mock/live-browser/tabs',
            'POST /__mock/onboarding/harness-check',
            'POST /__mock/onboarding/harness-login',
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

describe('live browser levers', () => {
    const SITE = 'https://shop.example';

    it('answer 404 capability-not-supported while MOCK_LIVE_BROWSER is off', async () => {
        const { post } = await start();
        for (const [path, body] of [
            ['/__mock/live-browser/tabs', { origin: SITE }],
            ['/__mock/live-browser/help-requests', { reason: 'login', message: 'Stuck.' }],
            ['/__mock/live-browser/navigate', { tabId: 'tab-1', page: { kind: 'browser-page' } }],
            ['/__mock/live-browser/elapse', { sessionId: 'session-1', what: 'idle' }],
        ] as const) {
            const answer = await post(path, body);
            expect(answer.response.status, path).toBe(404);
            expect(answer.body['code'], path).toBe('capability-not-supported');
        }
    });

    it('open an agent tab, in a chat or in none', async () => {
        const { runtime, post } = await start({ liveBrowser: true, scenario: 'small-team' });
        const plain = await post('/__mock/live-browser/tabs', { origin: 'https://work-1.conformance.invalid' });
        expect(plain.response.status).toBe(201);
        expect(plain.body['tab']).toMatchObject({
            origin: 'https://work-1.conformance.invalid',
            chatId: null,
            taskId: null,
            runId: null,
            agentState: 'working',
        });
        const tabId = (plain.body['tab'] as { id: string }).id;
        expect(runtime.controller().getBrowserTab(tabId)).toBeDefined();
        const inChat = await post('/__mock/live-browser/tabs', { origin: SITE, chatId: 'chat-1' });
        expect(inChat.body['tab']).toMatchObject({ chatId: 'chat-1' });
        for (const body of [{ origin: 'http://shop.example' }, { origin: `${SITE}/cart` }, { origin: SITE, x: 1 }]) {
            expect((await post('/__mock/live-browser/tabs', body)).response.status).toBe(400);
        }
    });

    it('raise a help request on the startup tab by default, or on the tab named', async () => {
        const { runtime, post } = await start({ liveBrowser: true });
        const startup = runtime.liveBrowserTab();
        const raised = await post('/__mock/live-browser/help-requests', { reason: 'captcha', message: 'A puzzle.' });
        expect(raised.response.status).toBe(201);
        expect(raised.body['request']).toMatchObject({ tabId: startup, reason: 'captcha', status: 'pending' });
        const tab = await post('/__mock/live-browser/tabs', { origin: SITE });
        const tabId = (tab.body['tab'] as { id: string }).id;
        const named = await post('/__mock/live-browser/help-requests', { tabId, reason: 'login', message: '' });
        expect(named.body['request']).toMatchObject({ tabId, reason: 'login' });
        const unknown = await post('/__mock/live-browser/help-requests', {
            tabId: 'tab-nowhere',
            reason: 'login',
            message: 'x',
        });
        expect(unknown.response.status).toBe(404);
        const long = await post('/__mock/live-browser/help-requests', { reason: 'other', message: 'x'.repeat(501) });
        expect(long.response.status).toBe(400);
    });

    it('refuse a help request on a sign-in tab, where no agent works', async () => {
        const { runtime, post } = await start({ liveBrowser: true });
        const opened = await ownerClient(runtime).browser.openSignIn(
            { browser: null, origin: 'https://accounts.example' },
            AbortSignal.timeout(5_000),
        );
        if (opened.kind !== 'ok') throw new Error(opened.problem.code);
        const refused = await post('/__mock/live-browser/help-requests', {
            tabId: opened.data.tabId,
            reason: 'login',
            message: 'x',
        });
        expect(refused.response.status).toBe(400);
        expect(refused.body['errors']).toEqual([{ path: 'body.tabId', message: 'Not an agent’s tab.' }]);
    });

    it('move a tab to another origin, a browser page or a secret page', async () => {
        const { runtime } = await start({ liveBrowser: true });
        const tabId = runtime.liveBrowserTab() ?? '';
        const navigate = (page: object, id = tabId) =>
            fetch(`http://127.0.0.1:${String(servers.at(-1)?.port)}/__mock/live-browser/navigate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tabId: id, page }),
            });
        expect((await navigate({ kind: 'web', origin: 'https://elsewhere.example' })).status).toBe(204);
        expect(runtime.controller().getBrowserTab(tabId)?.origin).toBe('https://elsewhere.example');
        expect((await navigate({ kind: 'secret-page' })).status).toBe(204);
        expect(runtime.controller().getBrowserTab(tabId)?.origin).toBeNull();
        expect((await navigate({ kind: 'browser-page' })).status).toBe(204);
        expect((await navigate({ kind: 'web', origin: 'https://x.example' }, 'tab-nowhere')).status).toBe(404);
        expect((await navigate({ kind: 'secret-page', origin: 'https://x.example' })).status).toBe(400);
        expect((await navigate({ kind: 'desktop' })).status).toBe(400);
    });

    it('end an open session as if its time or idle limit ran out, and 404 for any other', async () => {
        const { runtime } = await start({ liveBrowser: true });
        const client = ownerClient(runtime);
        const signal = AbortSignal.timeout(5_000);
        const tabId = runtime.liveBrowserTab() ?? '';
        const watched = await client.browser.watch(BrowserTabId.parse(tabId), signal);
        if (watched.kind !== 'ok') throw new Error(watched.problem.code);
        const elapse = (sessionId: string, what: string) =>
            fetch(`http://127.0.0.1:${String(servers.at(-1)?.port)}/__mock/live-browser/elapse`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, what }),
            });
        expect((await elapse(watched.data.id, 'expired')).status).toBe(204);
        const ended = await client.browser.getSession(watched.data.id, signal);
        expect(ended.kind === 'ok' && ended.data).toMatchObject({ status: 'ended', endReason: 'expired' });
        expect((await elapse(watched.data.id, 'idle')).status).toBe(404);
        expect((await elapse('session-nowhere', 'expired')).status).toBe(404);
        expect((await elapse(watched.data.id, 'later')).status).toBe(400);
    });
});
