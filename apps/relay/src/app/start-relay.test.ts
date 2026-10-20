import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeClock } from '../adapters/fake-clock';
import type { MemoryLogger } from '../adapters/memory-logger';
import { createMemoryLogger } from '../adapters/memory-logger';
import { StaticRegistryError } from '../adapters/static-file-registry';
import type { TestEngine } from '../testing/engines';
import { createTestEngine } from '../testing/engines';
import { parseRelayConfig } from './config';
import { UnsupportedRegistryError, createRelayServices, startRelay } from './start-relay';

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
            RELAY_TLS_CERT_FILE: '/run/relay/cert.pem',
            RELAY_TLS_KEY_FILE: '/run/relay/key.pem',
            RELAY_REGISTRY_KIND: 'static',
            RELAY_REGISTRY_FILE: registryFile,
            ...overrides,
        });
    const writeRegistry = (...engines: readonly TestEngine[]) =>
        writeFile(
            registryFile,
            JSON.stringify({ v: 1, engines: engines.map(({ engineId, entry }) => ({ engineId, ...entry })) }),
        );
    const deps = () => ({ logger, clock: createFakeClock(1_700_000_000_000) });
    const events = () => logger.entries.map((entry) => entry.event);

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'relay-start-'));
        registryFile = join(dir, 'registry.json');
        logger = createMemoryLogger();
        engine = await createTestEngine(40);
        await writeRegistry(engine);
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
            fields: { relayId: 'relay-a.ptbk.test', registry: 'static' },
        });
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

    it('refuses the http registry until its adapter exists', async () => {
        const config = env({
            RELAY_REGISTRY_KIND: 'http',
            RELAY_REGISTRY_URL: 'https://app.ptbk.test',
            RELAY_REGISTRY_TOKEN: `ptbk_rt_${'A'.repeat(43)}`,
            RELAY_REGISTRY_FILE: '',
        });
        await expect(startRelay(config, deps())).rejects.toBeInstanceOf(UnsupportedRegistryError);
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
