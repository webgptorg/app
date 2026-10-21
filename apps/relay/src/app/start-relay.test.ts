import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeClock } from '../adapters/fake-clock';
import { systemClock } from '../adapters/system-clock';
import type { MemoryLogger } from '../adapters/memory-logger';
import { createMemoryLogger } from '../adapters/memory-logger';
import { createInMemoryRegistry } from '../adapters/in-memory-registry';
import { StaticRegistryError } from '../adapters/static-file-registry';
import type { TestEngine } from '../testing/engines';
import { createTestEngine } from '../testing/engines';
import { TEST_RELAY_TOKEN, startFakeDashboard } from '../testing/fake-dashboard';
import { createFakeRandom } from '../testing/fake-random';
import { relayCertificate } from '../testing/relay-harness';
import { createTestCertificate } from '../testing/test-pki';
import { parseRelayConfig } from './config';
import { RelayTlsError, createRelayServices, startRelay } from './start-relay';

const signal = new AbortController().signal;

describe('startRelay', () => {
    let dir: string;
    let registryFile: string;
    let logger: MemoryLogger;
    let engine: TestEngine;

    const env = (overrides: Record<string, string> = {}) =>
        parseRelayConfig({
            RELAY_HOSTNAME: 'relay-a.ptbk.test',
            RELAY_ENGINE_DOMAIN: 'engine.test',
            RELAY_LISTEN_HOST: '127.0.0.1',
            RELAY_LISTEN_PORT: '0',
            RELAY_TLS_CERT_FILE: join(dir, 'cert.pem'),
            RELAY_TLS_KEY_FILE: join(dir, 'key.pem'),
            RELAY_REGISTRY_KIND: 'static',
            RELAY_REGISTRY_FILE: registryFile,
            ...overrides,
        });
    const writeRegistry = (...engines: readonly TestEngine[]) =>
        writeFile(
            registryFile,
            JSON.stringify({ v: 1, engines: engines.map(({ engineId, entry }) => ({ engineId, ...entry })) }),
        );
    const deps = () => ({
        logger,
        clock: createFakeClock(1_700_000_000_000),
        livenessClock: systemClock,
        random: createFakeRandom(),
    });
    const events = () => logger.entries.map((entry) => entry.event);

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'relay-start-'));
        registryFile = join(dir, 'registry.json');
        logger = createMemoryLogger();
        engine = await createTestEngine(40);
        await writeRegistry(engine);
        await writeFile(join(dir, 'cert.pem'), relayCertificate().cert);
        await writeFile(join(dir, 'key.pem'), relayCertificate().key);
    });
    afterEach(async () => {
        await rm(dir, { recursive: true });
    });

    it('starts on the static registry, logs relay.started and stops on close', async () => {
        const listeners = process.listenerCount('SIGHUP');
        const relay = await startRelay(env(), deps());
        expect(process.listenerCount('SIGHUP')).toBe(listeners + 1);
        expect(logger.entries).toContainEqual({
            level: 'info',
            event: 'relay.started',
            fields: { relayId: 'relay-a.ptbk.test', registry: 'static', port: relay.port },
        });
        expect(relay.port).toBeGreaterThan(0);
        await relay.close();
        await relay.close();
        expect(process.listenerCount('SIGHUP')).toBe(listeners);
        expect(events().filter((event) => event === 'relay.stopped')).toHaveLength(1);
    });

    it('reloads the registry file on SIGHUP', async () => {
        const relay = await startRelay(env(), deps());
        try {
            const next = await createTestEngine(41);
            await writeRegistry(engine, next);
            process.emit('SIGHUP', 'SIGHUP');
            await vi.waitFor(() => {
                expect(logger.entries.at(-1)).toEqual({
                    level: 'info',
                    event: 'registry.loaded',
                    fields: { engines: 2 },
                });
            });
        } finally {
            await relay.close();
        }
    });

    it('refuses to start on an invalid registry file', async () => {
        await writeFile(registryFile, JSON.stringify({ v: 1, engines: [], extra: true }));
        await expect(startRelay(env(), deps())).rejects.toBeInstanceOf(StaticRegistryError);
    });

    it.each<[string, (dir: string) => Record<string, string>]>([
        ['a missing certificate', () => ({ RELAY_TLS_CERT_FILE: '/nonexistent/cert.pem' })],
        ['a key that is not PEM', () => ({ RELAY_TLS_KEY_FILE: '/dev/null' })],
        ['a key that does not match the certificate', (at) => ({ RELAY_TLS_KEY_FILE: join(at, 'other-key.pem') })],
    ])('refuses to start with %s', async (_, overrides) => {
        await writeFile(join(dir, 'other-key.pem'), createTestCertificate(['relay-a.ptbk.test']).key);
        await expect(startRelay(env(overrides(dir)), deps())).rejects.toBeInstanceOf(RelayTlsError);
    });

    it('starts on the dashboard registry, read through the cache', async () => {
        const dashboard = await startFakeDashboard(createInMemoryRegistry([[engine.engineId, engine.entry]]));
        try {
            const relay = await startRelay(
                env({
                    RELAY_REGISTRY_KIND: 'http',
                    RELAY_REGISTRY_URL: dashboard.url,
                    RELAY_REGISTRY_TOKEN: TEST_RELAY_TOKEN,
                    RELAY_REGISTRY_FILE: '',
                }),
                deps(),
            );
            const services = await createRelayServices(
                env({
                    RELAY_REGISTRY_KIND: 'http',
                    RELAY_REGISTRY_URL: `${dashboard.url}/`,
                    RELAY_REGISTRY_TOKEN: TEST_RELAY_TOKEN,
                    RELAY_REGISTRY_FILE: '',
                }),
                deps(),
            );
            await expect(services.registry.lookup(engine.engineId, signal)).resolves.toEqual({
                kind: 'found',
                entry: engine.entry,
            });
            await expect(services.registry.lookup(engine.engineId, signal)).resolves.toEqual({
                kind: 'found',
                entry: engine.entry,
            });
            await services.reload();
            // The second lookup was a fresh cache hit.
            expect(dashboard.requests()).toBe(1);
            expect(logger.entries.find((entry) => entry.event === 'relay.started')?.fields['registry']).toBe('http');
            await relay.close();
        } finally {
            await dashboard.close();
        }
    });
});

describe('createRelayServices', () => {
    it('wraps the static registry in the cache and reloads it on demand', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'relay-services-'));
        try {
            const registryFile = join(dir, 'registry.json');
            const engine = await createTestEngine(42);
            await writeFile(
                registryFile,
                JSON.stringify({ v: 1, engines: [{ engineId: engine.engineId, ...engine.entry }] }),
            );
            const logger = createMemoryLogger();
            const services = await createRelayServices(
                parseRelayConfig({
                    RELAY_HOSTNAME: 'relay-a.ptbk.test',
                    RELAY_ENGINE_DOMAIN: 'engine.test',
                    RELAY_TLS_CERT_FILE: '/run/relay/cert.pem',
                    RELAY_TLS_KEY_FILE: '/run/relay/key.pem',
                    RELAY_REGISTRY_KIND: 'static',
                    RELAY_REGISTRY_FILE: registryFile,
                    RELAY_DNS_SERVERS: '127.0.0.1',
                }),
                { logger, clock: createFakeClock(0) },
            );
            await expect(services.registry.lookup(engine.engineId, signal)).resolves.toEqual({
                kind: 'found',
                entry: engine.entry,
            });
            await writeFile(registryFile, JSON.stringify({ v: 1, engines: [] }));
            await services.reload();
            // Still within the TTL: the cache answers, not the file.
            await expect(services.registry.lookup(engine.engineId, signal)).resolves.toMatchObject({ kind: 'found' });
            await expect(services.dns.resolveCname(engine.defaultHostname, AbortSignal.abort())).rejects.toThrow();
        } finally {
            await rm(dir, { recursive: true });
        }
    });
});
