import type { LinkCode } from '@ptbk/protocol';
import {
    EngineVersion,
    Heartbeat,
    Hostname,
    RelayId,
    TunnelAuth as TunnelAuthSchema,
    encodeBase64Url,
    heartbeatPath,
} from '@ptbk/protocol';
import { ENGINE_API_ROUTES, MemberId, OWNER_PERMISSIONS, SessionId } from '@ptbk/engine-api';
import { afterEach, describe, expect, it } from 'vitest';

import { createFetchDashboardApi } from '../src/adapters/fetch-dashboard-api';
import { createMemoryIdentityStore } from '../src/adapters/memory-identity-store';
import { createMemoryRegistrationStore } from '../src/testing/memory-registration-store';
import { createMemorySeqStore } from '../src/testing/memory-seq-store';
import type { MockEngineConfig } from '../src/app/config';
import { RegistrationFailedError } from '../src/app/establish-registration';
import type { DashboardDeps, MockEngine } from '../src/app/start-mock-engine';
import { startMockEngine } from '../src/app/start-mock-engine';
import { oneTimeSecret } from '../src/domain/secret';
import type { IdentityStore } from '../src/domain/identity/engine-identity';
import type { RelayTarget } from '../src/domain/tunnel/relay-target';
import type { FakeDashboard } from '../src/testing/fake-dashboard';
import { createFakeDashboard } from '../src/testing/fake-dashboard';
import type { FakeClock } from '../src/testing/fake-clock';
import { createFakeClock } from '../src/testing/fake-clock';
import type { FakeDialer } from '../src/testing/fake-dialer';
import { createFakeDialer, flush, until } from '../src/testing/fake-dialer';
import type { MemoryLogger } from '../src/testing/memory-logger';
import { createMemoryLogger } from '../src/testing/memory-logger';
import { DEFAULT_MOCK_SETTINGS } from '../src/testing/mock-settings';
import { createSeededRandom } from '../src/testing/seeded-random';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const DASHBOARD_URL = 'https://app.ptbk.test';
const DASHBOARD_RELAYS = [Hostname.parse('relay-x.ptbk.test'), Hostname.parse('relay-y.ptbk.test')];
const START_MS = Date.parse('2026-10-20T10:00:00Z');

function relay(name: string): RelayTarget {
    return { url: `wss://${name}:8443/v1/tunnel`, relayId: RelayId.parse(name), port: 8443 };
}

const BASE: MockEngineConfig = {
    mode: 'tunnel',
    dataDir: '/unused',
    relays: [relay('relay-dev.ptbk.test')],
    engineDomain: ENGINE_DOMAIN,
    engineVersion: EngineVersion.parse('0.1.0'),
    proxy: null,
    extraCaFile: null,
    devCaFiles: null,
    devCaDomains: [],
    logLevel: 'info',
    ...DEFAULT_MOCK_SETTINGS,
};

function linked(
    linkCode: LinkCode | null,
    patch: Partial<NonNullable<MockEngineConfig['dashboard']>> = {},
): MockEngineConfig {
    return {
        ...BASE,
        dashboard: {
            url: DASHBOARD_URL,
            linkCode: linkCode === null ? null : oneTimeSecret(linkCode),
            heartbeatIntervalS: 60,
            relaysOverride: false,
            ...patch,
        },
    };
}

interface World {
    readonly clock: FakeClock;
    readonly logger: MemoryLogger;
    readonly dashboard: FakeDashboard;
    readonly identityStore: IdentityStore;
    readonly deps: DashboardDeps;
}

function world(clockOffsetMs = 0): World {
    const clock = createFakeClock(START_MS);
    const dashboard = createFakeDashboard({
        clock,
        engineDomain: ENGINE_DOMAIN,
        relays: DASHBOARD_RELAYS,
        clockOffsetMs,
    });
    return {
        clock,
        logger: createMemoryLogger(),
        dashboard,
        identityStore: createMemoryIdentityStore(),
        deps: {
            // Over HTTP semantics, so the adapter's tolerant reading and status mapping take part too.
            api: createFetchDashboardApi({ baseUrl: DASHBOARD_URL, fetch: dashboard.fetch, clock }),
            registrations: createMemoryRegistrationStore(),
            seqs: createMemorySeqStore(clock),
            systemStats: {
                sample: () => Promise.resolve({ diskPct: 44, ramPct: 46, cpuLoad: 'low' as const }),
            },
        },
    };
}

const engines: MockEngine[] = [];
afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.close();
});

async function start(w: World, config: MockEngineConfig, dialer: FakeDialer = createFakeDialer()) {
    const engine = await startMockEngine(config, {
        logger: w.logger,
        clock: w.clock,
        random: createSeededRandom(1),
        identityStore: w.identityStore,
        dialer,
        dashboard: w.deps,
    });
    engines.push(engine);
    return { engine, dialer };
}

async function beats(w: World, count: number): Promise<void> {
    await until(() => w.dashboard.heartbeats.length >= count);
    await flush(3);
}

async function read(engine: MockEngine, id: 'getSecurityOverview' | 'getEngine') {
    const owner = engine.runtime
        .controller()
        .inspect()
        .members.find(({ role }) => role === 'owner');
    if (owner === undefined) throw new Error('no owner');
    const result = await engine.runtime.core().transport({
        memberId: MemberId.parse(owner.id),
        sessionId: SessionId.parse('session-test'),
        client: { ip: '127.0.0.1', userAgent: 'test' },
        permissions: new Set(OWNER_PERMISSIONS),
        stepUpFresh: true,
    })(ENGINE_API_ROUTES[id], {}, AbortSignal.timeout(5_000));
    if (result.kind !== 'ok') throw new Error(result.problem.code);
    return result.data as never;
}

const decoder = new TextDecoder();

describe('registration and heartbeat at startup', () => {
    it('registers with the link code, dials the relays it got back and sends the first beat at once', async () => {
        const w = world();
        const code = w.dashboard.issueLinkCode('org-a');
        const { engine, dialer } = await start(w, linked(code));
        expect(engine.registration).toMatchObject({ engineId: engine.identity.engineId, relays: DASHBOARD_RELAYS });
        expect(dialer.dials.map((dial) => dial.target.url)).toEqual([
            'wss://relay-x.ptbk.test/v1/tunnel',
            'wss://relay-y.ptbk.test/v1/tunnel',
        ]);
        const info: { dashboardUrl: string } = await read(engine, 'getEngine');
        expect(info.dashboardUrl).toBe(DASHBOARD_URL);
        await beats(w, 1);
        const first = w.dashboard.heartbeats[0];
        expect(first?.verification.kind).toBe('accepted');
        const body = decoder.decode(first?.rawBody);
        expect(Heartbeat.parse(JSON.parse(body))).toMatchObject({ diskPct: 40, ramPct: 50, cpuLoad: 'low' });
        const security: { lastHeartbeat: { sentAt: string; body: string } } = await read(engine, 'getSecurityOverview');
        expect(security.lastHeartbeat).toEqual({ sentAt: '2026-10-20T10:00:00Z', body });
        engine.runtime.reset({ seed: 3, scenario: 'empty' });
        const afterReset: { lastHeartbeat: { body: string } } = await read(engine, 'getSecurityOverview');
        expect(afterReset.lastHeartbeat.body).toBe(body);
        expect(w.logger.text()).not.toContain(code);
        expect(w.logger.text()).not.toContain(first?.signature ?? 'signature');
    });

    it('starts again from the stored registration without a network call, and seq keeps increasing', async () => {
        const w = world();
        const first = await start(w, linked(w.dashboard.issueLinkCode('org-a')));
        await beats(w, 1);
        await first.engine.close();
        const second = await start(w, linked(null));
        expect(second.engine.registration?.engineId).toBe(first.engine.identity.engineId);
        expect(w.dashboard.registerRequests).toHaveLength(1);
        await beats(w, 2);
        w.clock.advance(60_000);
        await beats(w, 3);
        expect(w.dashboard.heartbeats.map((beat) => beat.verification.kind)).toEqual([
            'accepted',
            'accepted',
            'accepted',
        ]);
    });

    it('keeps PTBK_RELAYS with MOCK_RELAYS_OVERRIDE', async () => {
        const w = world();
        const { dialer } = await start(w, linked(w.dashboard.issueLinkCode('org-a'), { relaysOverride: true }));
        expect(dialer.dials.map((dial) => dial.target.url)).toEqual(['wss://relay-dev.ptbk.test:8443/v1/tunnel']);
    });

    it('refuses to start unregistered without a link code, or when the dashboard rejects the code', async () => {
        const w = world();
        await expect(start(w, linked(null))).rejects.toThrow(RegistrationFailedError);
        await expect(start(w, linked(w.dashboard.issueLinkCode('org-a')))).resolves.toBeDefined();
        const other = world();
        const code = other.dashboard.issueLinkCode('org-a');
        other.dashboard.overrideRegister(() => ({
            status: 400,
            body: { type: 'about:blank', title: 'x', status: 400, code: 'invalid-link-code' },
        }));
        await expect(start(other, linked(code))).rejects.toThrow('registration rejected: invalid-link-code');
        expect(other.logger.text()).not.toContain(code);
    });

    it('keeps the tunnels up while the dashboard is unreachable, and the next beat uses the next seq', async () => {
        const w = world();
        const { engine, dialer } = await start(w, linked(w.dashboard.issueLinkCode('org-a')));
        await beats(w, 1);
        w.dashboard.unreachable = true;
        w.clock.advance(60_000);
        await until(() => w.logger.entries.some((entry) => entry.event === 'heartbeat.unavailable'));
        const dial = dialer.dials[0];
        if (dial === undefined) throw new Error('no dial');
        const connection = dial.open();
        await flush();
        connection.relayJson({
            v: 1,
            type: 'challenge',
            nonce: encodeBase64Url(new Uint8Array(32).fill(1)),
            relayId: dial.target.relayId,
            protocolVersions: [1],
            features: [],
        });
        await until(() => connection.texts.length === 1);
        TunnelAuthSchema.parse(JSON.parse(connection.texts[0] ?? ''));
        connection.relayJson({ v: 1, type: 'ready', protocolVersion: 1, features: [], hostnames: [engine.hostname] });
        await until(() => engine.links[0]?.state().kind === 'ready');
        w.dashboard.unreachable = false;
        w.clock.advance(60_000);
        await beats(w, 2);
        const [one, two] = w.dashboard.heartbeats.map((beat) =>
            beat.verification.kind === 'accepted' ? beat.verification.heartbeat.seq : -1,
        );
        expect(two).toBeGreaterThan((one ?? 0) + 1);
        expect(engine.links[0]?.state().kind).toBe('ready');
        engines.splice(engines.indexOf(engine), 1);
        const closing = engine.close();
        await until(() => connection.closeCodes.length > 0);
        connection.relayClose(1001);
        await closing;
    });

    it('shows the clock skew from a stale-timestamp answer on the control listener', async () => {
        const w = world(300_000);
        const { engine } = await start(w, {
            ...linked(w.dashboard.issueLinkCode('org-a')),
            control: { host: '127.0.0.1', port: 0 },
        });
        await until(() => engine.heartbeat?.status().clockSkew !== null);
        const response = await fetch(`http://127.0.0.1:${String(engine.control?.port)}/__mock/heartbeat`);
        const status = (await response.json()) as { clockSkew: { seconds: number }; lastHeartbeat: { body: string } };
        expect(status.clockSkew.seconds).toBe(-300);
        expect(status.lastHeartbeat.body).toBe(decoder.decode(w.dashboard.heartbeats[0]?.rawBody));
        expect(w.logger.entries).toContainEqual({
            level: 'warn',
            event: 'heartbeat.clock-skew',
            fields: { seconds: -300 },
        });
    });

    it('reports fixed figures per scenario with MOCK_STATS=scenario', async () => {
        const w = world();
        const { engine } = await start(w, { ...linked(w.dashboard.issueLinkCode('org-a')), stats: 'scenario' });
        await beats(w, 1);
        const sent = Heartbeat.parse(JSON.parse(decoder.decode(w.dashboard.heartbeats[0]?.rawBody)));
        expect(sent).toMatchObject({ diskPct: 40, ramPct: 50, cpuLoad: 'medium', update: 'none', members: 5 });
        expect(sent.engineId).toBe(engine.identity.engineId);
        expect(heartbeatPath(sent.engineId)).toBe(`/v1/engines/${engine.identity.engineId}/heartbeat`);
    });

    it('sends nothing to a dashboard in the M1 dev mode', async () => {
        const w = world();
        const { engine, dialer } = await start(w, BASE);
        expect(engine.registration).toBeNull();
        expect(engine.heartbeat).toBeNull();
        expect(dialer.dials.map((dial) => dial.target.relayId)).toEqual(['relay-dev.ptbk.test']);
        w.clock.advance(120_000);
        await flush(3);
        expect(w.dashboard.heartbeats).toHaveLength(0);
        expect(w.dashboard.registerRequests).toHaveLength(0);
    });
});
