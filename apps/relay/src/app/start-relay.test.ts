import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';

import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';
import { WebSocket } from 'ws';

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
import type { TestEngineClient } from '../testing/engine-client';
import { connectEngine } from '../testing/engine-client';
import { RELAY_ID, relayCertificate } from '../testing/relay-harness';
import { createTestCertificate } from '../testing/test-pki';
import { parseRelayConfig } from './config';
import type { Relay } from './start-relay';
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
                expect(logger.entries).toContainEqual({
                    level: 'info',
                    event: 'registry.loaded',
                    fields: { engines: 2 },
                });
            });
        } finally {
            await relay.close();
        }
    });

    /** An authenticated tunnel to `relay`, trusting `ca`. */
    const tunnel = async (relay: Relay, ca = relayCertificate().cert): Promise<TestEngineClient> => {
        const client = connectEngine({ port: relay.port, relayId: RELAY_ID, ca, signer: engine.signer });
        const challenge = await client.nextMessage();
        if (challenge.type !== 'challenge') throw new Error('expected a challenge');
        await client.authenticate(challenge);
        expect(await client.nextMessage()).toMatchObject({ type: 'ready' });
        return client;
    };
    const fingerprintAt = (port: number): Promise<string | undefined> =>
        new Promise((resolve) => {
            const socket = connectTls({ host: '127.0.0.1', port, servername: RELAY_ID, rejectUnauthorized: false });
            socket.once('secureConnect', () => {
                resolve(socket.getPeerX509Certificate()?.fingerprint256);
                socket.destroy();
            });
        });

    it('loads a new certificate on SIGHUP for new connections, keeping open tunnels connected', async () => {
        const relay = await startRelay(env(), deps());
        try {
            const client = await tunnel(relay);
            const next = createTestCertificate([RELAY_ID]);
            await writeFile(join(dir, 'cert.pem'), next.cert);
            await writeFile(join(dir, 'key.pem'), next.key);
            process.emit('SIGHUP', 'SIGHUP');
            await vi.waitFor(() => {
                expect(events()).toContain('relay.certificate-loaded');
            });
            expect(await fingerprintAt(relay.port)).toBe(new X509Certificate(next.cert).fingerprint256);
            expect(client.ws.readyState).toBe(WebSocket.OPEN);
            await tunnel(relay, next.cert);
            client.ws.terminate();
        } finally {
            await relay.close();
        }
    });

    it.each<[string, () => Promise<void>, string]>([
        [
            'a key that does not match',
            () => writeFile(join(dir, 'key.pem'), createTestCertificate([RELAY_ID]).key),
            'Error',
        ],
        [
            'a certificate for the engine domain',
            async () => {
                const engineWide = createTestCertificate([RELAY_ID, '*.engine.test']);
                await writeFile(join(dir, 'cert.pem'), engineWide.cert);
                await writeFile(join(dir, 'key.pem'), engineWide.key);
            },
            'RELAY_TLS_CERT_FILE must not be valid for RELAY_ENGINE_DOMAIN or any name under it',
        ],
    ])('keeps the old certificate on SIGHUP when the new files hold %s', async (_, replace, problem) => {
        const relay = await startRelay(env(), deps());
        try {
            await replace();
            process.emit('SIGHUP', 'SIGHUP');
            await vi.waitFor(() => {
                expect(logger.entries).toContainEqual({
                    level: 'error',
                    event: 'relay.certificate-rejected',
                    fields: { problem },
                });
            });
            expect(await fingerprintAt(relay.port)).toBe(new X509Certificate(relayCertificate().cert).fingerprint256);
        } finally {
            await relay.close();
        }
    });

    it('expires the registry cache and revalidates on SIGHUP, so a suspension takes effect at once', async () => {
        const relay = await startRelay(env(), deps());
        try {
            const client = await tunnel(relay);
            await writeFile(
                registryFile,
                JSON.stringify({
                    v: 1,
                    engines: [{ engineId: engine.engineId, ...engine.entry, status: 'suspended' }],
                }),
            );
            process.emit('SIGHUP', 'SIGHUP');
            expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.SUSPENDED);
        } finally {
            await relay.close();
        }
    });

    it.each<[string, readonly string[]]>([
        ['the engine domain itself', ['engine.test']],
        ['a wildcard under it', [RELAY_ID, '*.engine.test']],
        ['a wildcard above it', [RELAY_ID, '*.test']],
        ['a name under it, written with a comma Node quotes', [RELAY_ID, 'a,b.engine.test']],
    ])('refuses to start with a certificate valid for %s', async (_, names) => {
        const engineWide = createTestCertificate(names);
        await writeFile(join(dir, 'cert.pem'), engineWide.cert);
        await writeFile(join(dir, 'key.pem'), engineWide.key);
        const failure = startRelay(env(), deps());
        await expect(failure).rejects.toBeInstanceOf(RelayTlsError);
        await expect(failure).rejects.toThrow(
            'RELAY_TLS_CERT_FILE must not be valid for RELAY_ENGINE_DOMAIN or any name under it',
        );
    });

    it('refuses to start with a file that is PEM but not a certificate', async () => {
        await writeFile(join(dir, 'cert.pem'), relayCertificate().key);
        await expect(startRelay(env(), deps())).rejects.toThrow(
            'RELAY_TLS_CERT_FILE and RELAY_TLS_KEY_FILE must be a readable PEM certificate and its private key',
        );
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
