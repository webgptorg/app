import type { RelayId } from '@ptbk/protocol';
import { RelayId as RelayIdSchema } from '@ptbk/protocol';

import type { FakeClock } from '../adapters/fake-clock';
import { createHttpEngineRegistry } from '../adapters/http-engine-registry';
import { createHttpPresenceSink } from '../adapters/http-presence-sink';
import type { InMemoryDnsResolver } from '../adapters/in-memory-dns-resolver';
import type { InMemoryRegistry } from '../adapters/in-memory-registry';
import type { MemoryLogger } from '../adapters/memory-logger';
import { systemClock } from '../adapters/system-clock';
import { createPrometheusMetrics } from '../adapters/prometheus-metrics';
import type { RelayConfig } from '../app/config';
import { parseRelayConfig } from '../app/config';
import type { RelayListener } from '../app/start-relay';
import { REGISTRY_NEGATIVE_TTL_MS, startRelayListener } from '../app/start-relay';
import { createCachedDnsResolver } from '../domain/cached-dns';
import { createCachedRegistry } from '../domain/cached-registry';
import type { Clock } from '../domain/clock';
import type { ConnectOptions, TestEngineClient } from './engine-client';
import { connectEngine } from './engine-client';
import type { TestEngine } from './engines';
import { ENGINE_DOMAIN } from './engines';
import type { FakeDashboard } from './fake-dashboard';
import { TEST_RELAY_TOKEN, startFakeDashboard } from './fake-dashboard';
import type { FakeRandom } from './fake-random';
import { createFakeRandom } from './fake-random';
import type { TestCertificate } from './test-pki';
import { createTestCertificate } from './test-pki';
import { createTestDeps } from './test-deps';

export const RELAY_ID: RelayId = RelayIdSchema.parse('relay-a.ptbk.test');

export interface RelayHarness {
    readonly config: RelayConfig;
    readonly listener: RelayListener;
    readonly port: number;
    readonly certificate: TestCertificate;
    readonly clock: FakeClock;
    readonly logger: MemoryLogger;
    /** The source behind the cached registry, as R-02 wires it. */
    readonly registry: InMemoryRegistry;
    /** The resolver behind the cached DNS resolver. */
    readonly dns: InMemoryDnsResolver;
    readonly random: FakeRandom;
    /** With `viaDashboard`: the fake dashboard the registry reads and presence reports go to. */
    readonly dashboard: FakeDashboard | null;
    connect(engine: TestEngine, options?: Partial<ConnectOptions>): TestEngineClient;
    close(): Promise<void>;
}

let sharedCertificate: TestCertificate | undefined;

/** The relay's certificate, generated once per test file. */
export function relayCertificate(): TestCertificate {
    sharedCertificate ??= createTestCertificate([RELAY_ID]);
    return sharedCertificate;
}

export interface HarnessOptions {
    readonly env?: Readonly<Record<string, string>>;
    /** Real time by default; a test of pings passes a fake one. */
    readonly livenessClock?: Clock;
    /**
     * Reads the registry as deployed (D-04): the HTTP adapter against a fake dashboard that answers from `registry`,
     * instead of reading `registry` directly. Presence reports then go to the same fake dashboard.
     */
    readonly viaDashboard?: boolean;
    /**
     * Runs limits, caches and deadlines on the system clock, so token buckets refill as they do in production: for
     * load tests that measure time. `clock.advance` then throws.
     */
    readonly realTime?: boolean;
}

function realTimeClock(): FakeClock {
    return {
        ...systemClock,
        advance() {
            throw new Error('this harness runs on real time');
        },
        pendingTimers: () => 0,
    };
}

/**
 * The tunnel listener on 127.0.0.1 and a free port, wired as `startRelay` wires it (cached registry and resolver over
 * in-memory sources), with a fake clock for deadlines, caching and revalidation.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<RelayHarness> {
    const deps = createTestDeps();
    const { logger, registry, dns } = deps;
    const clock = options.realTime === true ? realTimeClock() : deps.clock;
    const random = createFakeRandom();
    const metrics = createPrometheusMetrics();
    const certificate = relayCertificate();
    const config = parseRelayConfig({
        RELAY_HOSTNAME: RELAY_ID,
        RELAY_LISTEN_HOST: '127.0.0.1',
        RELAY_LISTEN_PORT: '0',
        RELAY_ENGINE_DOMAIN: ENGINE_DOMAIN,
        RELAY_TLS_CERT_FILE: '/unused/cert.pem',
        RELAY_TLS_KEY_FILE: '/unused/key.pem',
        RELAY_REGISTRY_KIND: 'static',
        RELAY_REGISTRY_FILE: '/unused/registry.json',
        ...options.env,
    });
    const dashboard = options.viaDashboard === true ? await startFakeDashboard(registry) : null;
    const cachedRegistry = createCachedRegistry({
        inner:
            dashboard === null
                ? registry
                : createHttpEngineRegistry({
                      fetch: (input, init) => fetch(input, init),
                      clock,
                      logger,
                      config: {
                          url: dashboard.url,
                          token: { reveal: () => TEST_RELAY_TOKEN },
                          timeoutMs: config.registry.timeoutMs,
                      },
                  }),
        clock,
        logger,
        metrics,
        ttlMs: config.registry.ttlMs,
        maxStaleMs: config.registry.maxStaleMs,
        negativeTtlMs: REGISTRY_NEGATIVE_TTL_MS,
        lookupTimeoutMs: config.registry.timeoutMs,
    });
    const cachedDns = createCachedDnsResolver({
        inner: dns,
        clock,
        logger,
        ttlMs: config.registry.ttlMs,
        maxStaleMs: config.registry.maxStaleMs,
        timeoutMs: config.dns.timeoutMs,
    });
    const presence =
        dashboard === null
            ? null
            : createHttpPresenceSink({
                  fetch: (input, init) => fetch(input, init),
                  clock,
                  config: {
                      url: dashboard.url,
                      token: { reveal: () => TEST_RELAY_TOKEN },
                      timeoutMs: config.registry.timeoutMs,
                  },
              });
    const listener = await startRelayListener(
        config,
        { registry: cachedRegistry, dns: cachedDns, presence },
        certificate,
        {
            logger,
            clock,
            livenessClock: options.livenessClock ?? systemClock,
            random,
            metrics,
        },
    );
    const clients: TestEngineClient[] = [];
    return {
        config,
        listener,
        port: listener.port,
        certificate,
        clock,
        logger,
        registry,
        dns,
        random,
        dashboard,
        connect(engine, overrides = {}) {
            const client = connectEngine({
                port: listener.port,
                relayId: RELAY_ID,
                ca: certificate.cert,
                signer: engine.signer,
                ...overrides,
            });
            clients.push(client);
            return client;
        },
        async close() {
            for (const client of clients) client.ws.terminate();
            await listener.close();
            await dashboard?.close();
        },
    };
}
