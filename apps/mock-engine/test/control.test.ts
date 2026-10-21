import type { TLSSocket } from 'node:tls';
import { connect } from 'node:tls';

import { ENGINE_API_PREFIX, SIGN_IN_PATH } from '@ptbk/engine-api';
import { createCryptoRandom, EngineVersion, Hostname, RelayId, defaultHostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { ControlServer } from '../src/adapters/control-server';
import { createDevCa, createDevCaCertificateSource } from '../src/adapters/dev-ca';
import { createMemoryIdentityStore } from '../src/adapters/memory-identity-store';
import { createWsRelayDialer } from '../src/adapters/ws-relay-dialer';
import type { MockEngineConfig } from '../src/app/config';
import { startMockEngine } from '../src/app/start-mock-engine';
import { ROLE_PERMISSIONS } from '../src/domain/authorization/policy';
import type { Clock } from '../src/domain/clock';
import { SESSION_COOKIE_NAME } from '../src/domain/gateway/sessions';
import type { ApiHarness } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';
import { startFakePassthrough } from '../src/testing/fake-passthrough';
import { startFakeRelay } from '../src/testing/fake-relay';
import { createMemoryLogger } from '../src/testing/memory-logger';
import { DEFAULT_MOCK_SETTINGS } from '../src/testing/mock-settings';
import { asBrowser, createNodeFetch } from '../src/testing/node-fetch';
import { lookupLoopback, trackLinkStates } from '../src/testing/test-hosts';
import { createTestCa } from '../src/testing/test-pki';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(): Promise<{ readonly harness: ApiHarness; readonly control: ControlServer }> {
    const harness = await createApiHarness();
    cleanups.push(() => harness.close());
    const control = await harness.startControl();
    return { harness, control };
}

function controlFetch(control: ControlServer) {
    return async (path: string, init: { method?: string; body?: unknown } = {}) => {
        const response = await fetch(`http://127.0.0.1:${String(control.port)}${path}`, {
            method: init.method ?? 'GET',
            ...(init.body === undefined
                ? {}
                : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
        });
        const text = await response.text();
        return {
            status: response.status,
            type: response.headers.get('content-type'),
            body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
        };
    };
}

async function me(harness: ApiHarness, cookie: string) {
    const response = await harness.fetch(cookie)(`${HARNESS_ORIGIN}${ENGINE_API_PREFIX}/me`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('control listener: sessions', () => {
    it('signs in the owner, a member of a role and a member with an explicit permission set', async () => {
        const { harness, control } = await setup();
        const call = controlFetch(control);

        const owner = await call('/__mock/sessions', { method: 'POST', body: { subject: { kind: 'owner' } } });
        expect(owner.status).toBe(201);
        const ownerCookie = owner.body?.['cookie'] as { name: string; value: string };
        expect(ownerCookie.name).toBe(SESSION_COOKIE_NAME);
        expect(await me(harness, `${ownerCookie.name}=${ownerCookie.value}`)).toMatchObject({
            status: 200,
            body: { memberId: owner.body?.['memberId'], role: 'owner' },
        });

        const viewer = await call('/__mock/sessions', {
            method: 'POST',
            body: { subject: { kind: 'member', role: 'viewer' } },
        });
        const viewerCookie = viewer.body?.['cookie'] as { name: string; value: string };
        const viewerMe = await me(harness, `${viewerCookie.name}=${viewerCookie.value}`);
        expect(viewerMe.body).toMatchObject({ memberId: viewer.body?.['memberId'], role: 'viewer' });
        expect([...(viewerMe.body['permissions'] as string[])].sort()).toEqual([...ROLE_PERMISSIONS.viewer].sort());

        const permissions = ['agents.read', 'secrets.read'];
        const first = await call('/__mock/sessions', {
            method: 'POST',
            body: { subject: { kind: 'member', permissions } },
        });
        const second = await call('/__mock/sessions', {
            method: 'POST',
            body: { subject: { kind: 'member', permissions } },
        });
        expect(first.body?.['memberId']).not.toBe(second.body?.['memberId']);
        const firstCookie = first.body?.['cookie'] as { name: string; value: string };
        expect((await me(harness, `${firstCookie.name}=${firstCookie.value}`)).body).toMatchObject({
            memberId: first.body?.['memberId'],
            permissions,
        });
        await harness.recorder.settled();
        expect(harness.recorder.violations).toEqual([]);
    });

    it.each([
        ['an unknown top-level field', { subject: { kind: 'owner' }, admin: true }],
        ['an unknown field in the subject', { subject: { kind: 'owner', role: 'admin' } }],
        ['both a role and a permission set', { subject: { kind: 'member', role: 'viewer', permissions: [] } }],
        ['an unknown permission', { subject: { kind: 'member', permissions: ['root'] } }],
        ['no subject', {}],
    ])('refuses %s with 400 problem+json', async (_name, body) => {
        const { control } = await setup();
        const result = await controlFetch(control)('/__mock/sessions', { method: 'POST', body });
        expect(result).toMatchObject({
            status: 400,
            type: 'application/problem+json',
            body: { code: 'validation-failed' },
        });
    });
});

describe('control listener: state', () => {
    it('reports counts and members', async () => {
        const { control } = await setup();
        const call = controlFetch(control);
        const state = await call('/__mock/state');
        expect(state.body).toMatchObject({ scenario: 'small-team', seed: 42, counts: { members: 5 } });
        const members = (await call('/__mock/members')).body?.['members'] as { id: string; role: string }[];
        expect(members.map(({ role }) => role).sort()).toEqual(['admin', 'member', 'member', 'owner', 'viewer']);
        expect(members.every(({ id }) => typeof id === 'string')).toBe(true);
    });

    it('replaces the state on reset and signs every session out', async () => {
        const { harness, control } = await setup();
        const call = controlFetch(control);
        const cookie = harness.signIn({ memberId: harness.ownerId() });
        expect((await me(harness, cookie)).status).toBe(200);
        const reset = await call('/__mock/reset', { method: 'POST', body: { scenario: 'empty', seed: 7 } });
        expect(reset).toMatchObject({
            status: 200,
            body: { scenario: 'empty', seed: 7, counts: { members: 1, agents: 0 } },
        });
        expect((await call('/__mock/state')).body).toMatchObject({ scenario: 'empty', seed: 7 });
        expect((await me(harness, cookie)).status).toBe(401);
        expect((await call('/__mock/reset', { method: 'POST', body: { scenario: 'huge', seed: 7 } })).status).toBe(400);
        expect((await call('/__mock/reset', { method: 'POST', body: { scenario: 'empty', seed: -1 } })).status).toBe(
            400,
        );
    });

    it('sets and clears the fault plan, strictly', async () => {
        const { harness, control } = await setup();
        const call = controlFetch(control);
        const set = await call('/__mock/faults', { method: 'PUT', body: { errorRate: 1, errorStatus: 503 } });
        expect(set).toMatchObject({ status: 200, body: { errorRate: 1, errorStatus: 503 } });
        expect(harness.faults.plan().errorRate).toBe(1);
        expect((await call('/__mock/faults', { method: 'PUT', body: { errorRate: 1, surprise: true } })).status).toBe(
            400,
        );
        expect((await call('/__mock/faults', { method: 'PUT', body: { errorRate: 2 } })).status).toBe(400);
        expect((await call('/__mock/faults', { method: 'DELETE' })).status).toBe(204);
        expect(harness.faults.plan().errorRate).toBe(0);
    });

    it('answers an unknown path, and an unknown query parameter, with problem+json', async () => {
        const { control } = await setup();
        const call = controlFetch(control);
        expect(await call('/__mock/nothing')).toMatchObject({ status: 404, body: { code: 'not-found' } });
        expect(await call('/__mock/state?x=1')).toMatchObject({ status: 400, body: { code: 'validation-failed' } });
        expect((await call('/__mock/sessions', { method: 'POST' })).status).toBe(415);
    });
});

describe('control listener: simulation (M-07)', () => {
    function agentAndTrigger(harness: ApiHarness) {
        const [agent] = harness.core().controller.findAgents();
        const [email] = harness.core().controller.findTriggers({ kind: 'email', lifecycle: 'active' });
        if (agent === undefined || email === undefined) throw new Error('seed lacks an agent or an email trigger');
        return { agent, email };
    }

    it('reports the capabilities and the simulation, and resets to a chosen set of capabilities', async () => {
        const { harness, control } = await setup();
        const call = controlFetch(control);
        expect((await call('/__mock/state')).body).toMatchObject({
            capabilities: ['runs@1', 'files@1', 'triggers@1', 'integrations@1'],
            simulation: { mode: 'paused', speed: 1, now: '2026-10-01T00:00:00.000Z' },
        });
        const reset = await call('/__mock/reset', {
            method: 'POST',
            body: { scenario: 'small-team', seed: 3, capabilities: ['runs', 'files'] },
        });
        expect(reset.body).toMatchObject({
            capabilities: ['runs@1', 'files@1'],
            counts: { runs: expect.any(Number) as number },
        });
        const owner = harness.signIn({ memberId: harness.ownerId() });
        const engine = await harness.fetch(owner)(`${HARNESS_ORIGIN}${ENGINE_API_PREFIX}/engine`);
        expect(((await engine.json()) as { capabilities: unknown }).capabilities).toEqual([
            { id: 'runs', version: 1 },
            { id: 'files', version: 1 },
        ]);
        const kept = await call('/__mock/reset', { method: 'POST', body: { scenario: 'empty', seed: 3 } });
        expect(kept.body).toMatchObject({ capabilities: ['runs@1', 'files@1'] });
        expect(
            (
                await call('/__mock/reset', {
                    method: 'POST',
                    body: { scenario: 'empty', seed: 3, capabilities: ['chats'] },
                })
            ).status,
        ).toBe(400);
    });

    it('switches mode and speed, and advances time only while paused', async () => {
        const { control } = await setup();
        const call = controlFetch(control);
        const advanced = await call('/__mock/simulation/advance', { method: 'POST', body: { ms: 90_000 } });
        expect(advanced).toMatchObject({ status: 200, body: { mode: 'paused', now: '2026-10-01T00:01:30.000Z' } });
        expect(
            await call('/__mock/simulation', { method: 'POST', body: { mode: 'running', speed: 120 } }),
        ).toMatchObject({
            status: 200,
            body: { mode: 'running', speed: 120 },
        });
        expect(await call('/__mock/simulation/advance', { method: 'POST', body: { ms: 1 } })).toMatchObject({
            status: 400,
            body: { code: 'validation-failed' },
        });
        expect((await call('/__mock/simulation', { method: 'POST', body: { mode: 'paused', speed: 0 } })).status).toBe(
            400,
        );
        expect((await call('/__mock/simulation', { method: 'POST', body: { mode: 'paused', extra: 1 } })).status).toBe(
            400,
        );
        expect((await call('/__mock/simulation', { method: 'POST', body: { mode: 'paused' } })).body).toMatchObject({
            mode: 'paused',
            speed: 120,
        });
        expect((await call('/__mock/simulation/advance', { method: 'POST', body: { ms: 86_400_001 } })).status).toBe(
            400,
        );
    });

    it('scripts a run that plays out as time advances', async () => {
        const { harness, control } = await setup();
        const call = controlFetch(control);
        const { agent } = agentAndTrigger(harness);
        const created = await call('/__mock/runs', {
            method: 'POST',
            body: {
                agentId: agent.id,
                outcome: 'completed',
                steps: [{ text: 'Fetch', toolName: 'web.fetch' }, { text: 'Write' }],
            },
        });
        expect(created).toMatchObject({ status: 201, body: { status: 'queued', source: 'api', agentId: agent.id } });
        const runId = created.body?.['id'] as string;
        await call('/__mock/simulation/advance', { method: 'POST', body: { ms: 30_000 } });
        expect(harness.core().controller.getRun(runId)).toMatchObject({
            status: 'completed',
            toolCalls: [{ name: 'web.fetch', state: 'complete' }],
        });
        const refused = [
            { agentId: 'agent-unknown', outcome: 'completed', steps: [{ text: 'x' }] },
            { agentId: agent.id, outcome: 'completed', steps: [] },
            { agentId: agent.id, outcome: 'maybe', steps: [{ text: 'x' }] },
            { agentId: agent.id, outcome: 'failed', steps: [{ text: 'x', toolName: 'Bad Tool' }] },
            { agentId: agent.id, outcome: 'failed', steps: [{ text: 'x' }], extra: true },
        ];
        for (const body of refused) {
            expect((await call('/__mock/runs', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
        }
    });

    it('starts an email run for an inbound email, and refuses other triggers', async () => {
        const { harness, control } = await setup();
        const call = controlFetch(control);
        const { email } = agentAndTrigger(harness);
        const inbound = { triggerId: email.id, from: 'customer@example.com', subject: 'Invoice question' };
        const fired = await call('/__mock/inbound-email', { method: 'POST', body: inbound });
        expect(fired).toMatchObject({ status: 201, body: { fire: { outcome: 'started' } } });
        const runId = (fired.body?.['fire'] as { runId: string }).runId;
        expect(harness.core().controller.getRun(runId)).toMatchObject({ source: 'email', triggerId: email.id });
        const [schedule] = harness.core().controller.findTriggers({ kind: 'schedule' });
        expect(
            await call('/__mock/inbound-email', { method: 'POST', body: { ...inbound, triggerId: schedule?.id } }),
        ).toMatchObject({ status: 400 });
        expect(
            await call('/__mock/inbound-email', { method: 'POST', body: { ...inbound, triggerId: 'trigger-unknown' } }),
        ).toMatchObject({ status: 404, body: { code: 'not-found' } });
        expect(
            (await call('/__mock/inbound-email', { method: 'POST', body: { ...inbound, from: 'nope' } })).status,
        ).toBe(400);
        expect(harness.logger.text()).not.toContain('Invoice question');
    });
});

describe('control routes through the tunnel', () => {
    const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
    const RELAY = RelayId.parse('relay-a.ptbk.test');
    const relayCa = createTestCa('M-04 control relay CA');
    const clock: Clock = {
        nowMs: () => Date.now(),
        setTimeout(fn, ms) {
            const timer = setTimeout(fn, ms);
            return () => {
                clearTimeout(timer);
            };
        },
    };

    it('answer 404 even with MOCK_CONTROL=enabled, while the control listener answers them', async () => {
        const identityStore = createMemoryIdentityStore();
        const identity = await identityStore.loadOrCreate();
        const hostname = defaultHostname(identity.engineId, ENGINE_DOMAIN);
        const relay = await startFakeRelay({
            relayId: RELAY,
            tls: relayCa.issue([RELAY]),
            registry: (engineId) =>
                engineId === identity.engineId ? { publicKey: identity.publicKey, hostnames: [hostname] } : undefined,
        });
        cleanups.push(() => relay.close());
        const logger = createMemoryLogger();
        const devCa = createDevCa([ENGINE_DOMAIN], clock);
        const states = trackLinkStates();
        const config: MockEngineConfig = {
            mode: 'tunnel',
            dataDir: '/unused',
            relays: [{ url: relay.url, relayId: RELAY, port: relay.port }],
            engineDomain: ENGINE_DOMAIN,
            engineVersion: EngineVersion.parse('0.1.0'),
            proxy: null,
            extraCaFile: null,
            devCaFiles: null,
            devCaDomains: [],
            certificateSource: { kind: 'dev-ca' },
            logLevel: 'info',
            ...DEFAULT_MOCK_SETTINGS,
            control: { host: '127.0.0.1', port: 0 },
        };
        const engine = await startMockEngine(config, {
            logger,
            clock,
            random: createCryptoRandom(),
            identityStore,
            dialer: createWsRelayDialer({ clock, proxy: null, ca: [relayCa.certPem], lookup: lookupLoopback }),
            certificates: createDevCaCertificateSource({ ca: devCa, clock, logger }),
            onLinkState: states.onLinkState,
        });
        let closed = false;
        cleanups.push(async () => {
            if (!closed) await engine.close();
        });
        await states.next(RELAY, 'ready');
        const passthrough = await startFakePassthrough(await relay.waitForSession());
        cleanups.push(() => passthrough.close());

        if (engine.control === null) throw new Error('control listener not started');
        const control = controlFetch(engine.control);
        expect((await control('/__mock/state')).status).toBe(200);

        const sockets = new Set<TLSSocket>();
        cleanups.push(() => {
            for (const socket of sockets) socket.destroy();
        });
        const tunnelFetch = asBrowser(
            createNodeFetch({
                host: hostname,
                connect: () => {
                    const socket = connect({
                        host: '127.0.0.1',
                        port: passthrough.port,
                        servername: hostname,
                        ca: devCa.certificatePem,
                        ALPNProtocols: ['http/1.1'],
                    });
                    sockets.add(socket);
                    return socket;
                },
            }),
            `https://${hostname}`,
            () => null,
        );
        const probes = [
            ['GET', '/__mock/state', undefined],
            ['GET', '/__mock/members', undefined],
            ['POST', '/__mock/sessions', { subject: { kind: 'owner' } }],
            ['POST', '/__mock/reset', { scenario: 'empty', seed: 1 }],
            ['PUT', '/__mock/faults', { errorRate: 1 }],
            ['DELETE', '/__mock/faults', undefined],
            ['POST', '/__mock/simulation', { mode: 'running', speed: 100 }],
            ['POST', '/__mock/simulation/advance', { ms: 60_000 }],
            ['POST', '/__mock/runs', { agentId: 'agent-x', outcome: 'completed', steps: [{ text: 'x' }] }],
            ['POST', '/__mock/inbound-email', { triggerId: 'trigger-x', from: 'a@example.com', subject: 'Hi' }],
        ] as const;
        for (const [method, path, body] of probes) {
            const response = await tunnelFetch(`https://${hostname}${path}`, {
                method,
                ...(body === undefined
                    ? {}
                    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
            });
            // A GET falls through to the app's routes, where the gateway sends an anonymous visitor to sign in.
            if (method === 'GET') {
                expect(response.status, `${method} ${path}`).toBe(303);
                expect(response.headers.get('location'), path).toBe(SIGN_IN_PATH);
                continue;
            }
            expect(response.status, `${method} ${path}`).toBe(404);
            expect(response.headers.get('content-type'), path).toBe('application/problem+json');
            expect(((await response.json()) as { code: string }).code, path).toBe('not-found');
        }
        expect(engine.faults.plan().errorRate).toBe(0);
        expect(engine.runtime.current().scenario).toBe('small-team');
        expect(engine.runtime.simulation().status()).toMatchObject({ mode: 'paused', speed: 1 });

        const port = engine.control.port;
        await engine.close();
        closed = true;
        await expect(fetch(`http://127.0.0.1:${String(port)}/__mock/state`)).rejects.toThrow();
    });
});
