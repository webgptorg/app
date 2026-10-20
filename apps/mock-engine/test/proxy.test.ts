import type { EngineId } from '@ptbk/protocol';
import { EngineVersion, Hostname, RelayId, defaultHostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryIdentityStore } from '../src/adapters/memory-identity-store';
import type { NoProxyRule, ProxyConfig } from '../src/adapters/proxy-config';
import { createWsRelayDialer } from '../src/adapters/ws-relay-dialer';
import type { MockEngineConfig } from '../src/app/config';
import { startMockEngine } from '../src/app/start-mock-engine';
import { secret } from '../src/domain/secret';
import type { ConnectProxy } from '../src/testing/connect-proxy';
import { startConnectProxy } from '../src/testing/connect-proxy';
import { createFakeClock } from '../src/testing/fake-clock';
import { startFakeRelay } from '../src/testing/fake-relay';
import { createMemoryLogger } from '../src/testing/memory-logger';
import { createSeededRandom } from '../src/testing/seeded-random';
import { lookupLoopback, trackLinkStates } from '../src/testing/test-hosts';
import { createTestCa } from '../src/testing/test-pki';
import { DEFAULT_MOCK_SETTINGS } from '../src/testing/mock-settings';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const RELAY = RelayId.parse('relay-a.ptbk.test');
const USERNAME = 'mock-engine';
const PASSWORD = 'proxy-password-never-logged';
const ca = createTestCa('M-01 proxy test CA');
const untrustedCa = createTestCa('M-01 untrusted CA');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Scenario {
    readonly password?: string;
    readonly noProxy?: readonly NoProxyRule[];
    readonly certificate?: { readonly certPem: string; readonly keyPem: string };
}

async function run(scenario: Scenario = {}) {
    const identityStore = createMemoryIdentityStore();
    const identity = await identityStore.loadOrCreate();
    const hostname = defaultHostname(identity.engineId, ENGINE_DOMAIN);
    const relay = await startFakeRelay({
        relayId: RELAY,
        tls: scenario.certificate ?? ca.issue([RELAY]),
        registry: (engineId: EngineId) =>
            engineId === identity.engineId ? { publicKey: identity.publicKey, hostnames: [hostname] } : undefined,
    });
    cleanups.push(() => relay.close());
    const proxy: ConnectProxy = await startConnectProxy({
        resolve: () => '127.0.0.1',
        requireAuth: { username: USERNAME, password: PASSWORD },
    });
    cleanups.push(() => proxy.close());

    const proxyConfig: ProxyConfig = {
        host: proxy.host,
        port: proxy.port,
        credentials: { username: USERNAME, password: secret(scenario.password ?? PASSWORD) },
        noProxy: scenario.noProxy ?? [],
    };
    const config: MockEngineConfig = {
        mode: 'tunnel',
        dataDir: '/unused',
        relays: [{ url: relay.url, relayId: RELAY, port: relay.port }],
        engineDomain: ENGINE_DOMAIN,
        engineVersion: EngineVersion.parse('0.1.0'),
        proxy: proxyConfig,
        extraCaFile: null,
        devCaFiles: null,
        devCaDomains: [],
        logLevel: 'info',
        ...DEFAULT_MOCK_SETTINGS,
    };
    const clock = createFakeClock(Date.now());
    const logger = createMemoryLogger();
    const states = trackLinkStates();
    const engine = await startMockEngine(config, {
        logger,
        clock,
        random: createSeededRandom(3),
        identityStore,
        // Direct dials resolve every name to loopback; proxied dials reach the relay only through the proxy.
        dialer: createWsRelayDialer({ clock, proxy: proxyConfig, ca: [ca.certPem], lookup: lookupLoopback }),
        onLinkState: states.onLinkState,
    });
    cleanups.push(() => engine.close());
    return { relay, proxy, clock, logger, states };
}

function dialFailures(logger: ReturnType<typeof createMemoryLogger>) {
    return logger.entries.filter((entry) => entry.event === 'tunnel.dial-failed').map((entry) => entry.fields);
}

describe('tunnel through an HTTP CONNECT proxy', () => {
    it('connects through the proxy, verifying the relay certificate for the relay hostname', async () => {
        const ctx = await run();
        await ctx.states.next(RELAY, 'ready');
        expect(ctx.proxy.requests).toEqual([
            { target: `${RELAY}:${String(ctx.relay.port)}`, hadAuth: true, status: 200 },
        ]);
        expect(ctx.relay.sessions()).toBe(1);
    });

    it('retries a 407 with backoff and logs the status without the credentials', async () => {
        const ctx = await run({ password: 'wrong-password-never-logged' });
        for (let attempt = 1; attempt <= 3; attempt++) {
            const state = await ctx.states.next(RELAY, 'backoff');
            if (state.kind !== 'backoff') throw new Error('expected backoff');
            expect(state.attempt).toBe(attempt);
            ctx.clock.advance(state.delayMs);
            await ctx.states.next(RELAY, 'connecting');
        }
        await ctx.states.next(RELAY, 'backoff');
        expect(ctx.proxy.requests.map((request) => request.status)).toEqual([407, 407, 407, 407]);
        expect(dialFailures(ctx.logger)).toEqual(
            [1, 2, 3, 4].map((attempt) => ({ relay: ctx.relay.url, attempt, reason: 'proxy-status', status: 407 })),
        );
        const logged = ctx.logger.text();
        for (const secretText of ['wrong-password-never-logged', PASSWORD, USERNAME, ctx.proxy.host]) {
            expect(logged).not.toContain(secretText);
        }
        expect(ctx.relay.connections()).toBe(0);
    });

    it.each([
        ['for another hostname', () => ca.issue(['relay-b.ptbk.test'])],
        ['from an untrusted CA', () => untrustedCa.issue([RELAY])],
    ])('fails the attempt when the relay certificate is %s', async (_name, certificate) => {
        const ctx = await run({ certificate: certificate() });
        await ctx.states.next(RELAY, 'backoff');
        expect(ctx.proxy.requests).toHaveLength(1);
        expect(dialFailures(ctx.logger)).toEqual([{ relay: ctx.relay.url, attempt: 1, reason: 'tls' }]);
        expect(ctx.relay.sessions()).toBe(0);
    });

    it('bypasses the proxy for a NO_PROXY match', async () => {
        const ctx = await run({ noProxy: [{ host: 'ptbk.test', port: null }] });
        await ctx.states.next(RELAY, 'ready');
        expect(ctx.proxy.requests).toEqual([]);
    });
});
