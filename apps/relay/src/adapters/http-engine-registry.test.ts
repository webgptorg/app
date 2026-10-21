import type { RegistryEntry } from '@ptbk/protocol';
import { Hostname as HostnameSchema, TUNNEL_FEATURES, expectedCnameTarget, signTunnelAuth } from '@ptbk/protocol';
import { EngineVersion, RelayId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createCachedRegistry } from '../domain/cached-registry';
import type { EngineRegistry } from '../domain/engine-registry';
import { routableHostnames } from '../domain/hostname-policy';
import { createChallenge, verifyAuth } from '../domain/tunnel/handshake';
import { toWireRejection } from '../domain/tunnel/reject-mapping';
import type { TestEngine } from '../testing/engines';
import { ENGINE_DOMAIN, createTestEngine } from '../testing/engines';
import { createFakeRandom } from '../testing/fake-random';
import type { TestDeps } from '../testing/test-deps';
import { createTestDeps } from '../testing/test-deps';
import type { RegistryFetch } from './http-engine-registry';
import { createHttpEngineRegistry } from './http-engine-registry';

const TOKEN = `ptbk_rt_${'Z'.repeat(43)}`;
const BASE = 'https://app.ptbk.test';
const TIMEOUT_MS = 3000;
const TTL_MS = 300_000;
const MAX_STALE_MS = 86_400_000;
const agents = HostnameSchema.parse('agents.customer.test');
const forged = HostnameSchema.parse('forged.customer.test');

type Answer = Response | 'network' | 'hang';

interface FakeFetch {
    readonly fetch: RegistryFetch;
    readonly calls: { readonly url: string; readonly init: RequestInit }[];
    answer(next: (engineId: string) => Answer): void;
}

function createFakeFetch(): FakeFetch {
    const calls: { url: string; init: RequestInit }[] = [];
    let respond: (engineId: string) => Answer = () => new Response(null, { status: 404 });
    return {
        calls,
        answer(next) {
            respond = next;
        },
        fetch(url, init) {
            calls.push({ url, init });
            const answer = respond(url.split('/').at(-1) ?? '');
            if (answer === 'network') return Promise.reject(new TypeError('fetch failed'));
            if (answer === 'hang') {
                return new Promise((_, reject) => {
                    init.signal?.addEventListener('abort', () => {
                        reject(init.signal?.reason as Error);
                    });
                });
            }
            return Promise.resolve(answer);
        },
    };
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createHttpEngineRegistry', () => {
    let deps: TestDeps;
    let fake: FakeFetch;
    let engine: TestEngine;
    let registry: EngineRegistry;
    const signal = new AbortController().signal;

    beforeEach(async () => {
        deps = createTestDeps();
        fake = createFakeFetch();
        engine = await createTestEngine(60, [agents]);
        registry = createHttpEngineRegistry({
            fetch: fake.fetch,
            clock: deps.clock,
            logger: deps.logger,
            config: { url: `${BASE}/`, token: { reveal: () => TOKEN }, timeoutMs: TIMEOUT_MS },
        });
    });

    const serving = (entry: unknown): void => {
        fake.answer((engineId) => (engineId === engine.engineId ? json(entry) : new Response(null, { status: 404 })));
    };
    const failures = () => deps.logger.entries.filter((entry) => entry.event === 'registry.error');

    it('sends one GET to registryPath with the relay key and no redirects, and parses a 200 as found', async () => {
        serving(engine.entry);
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'found', entry: engine.entry });
        expect(fake.calls).toHaveLength(1);
        const [call] = fake.calls;
        expect(call?.url).toBe(`${BASE}/internal/v1/engines/${engine.engineId}`);
        expect(call?.init).toMatchObject({
            method: 'GET',
            redirect: 'error',
            headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
        });
    });

    it('reads tolerantly: unknown fields from a newer dashboard are stripped (rule 5)', async () => {
        serving({
            ...engine.entry,
            addedLater: true,
            claims: engine.entry.claims.map((claim) => ({ ...claim, note: 1 })),
        });
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'found', entry: engine.entry });
    });

    it('answers 404 as not-found', async () => {
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'not-found' });
        expect(failures()).toEqual([]);
    });

    it.each<[string, () => Answer, string]>([
        ['a 500', () => new Response('boom', { status: 500 }), 'server-error'],
        ['a 503', () => new Response(null, { status: 503 }), 'server-error'],
        ['a 401', () => json({ code: 'unauthorized' }, 401), 'unauthorized'],
        ['a 403', () => new Response(null, { status: 403 }), 'unauthorized'],
        ['a 429', () => new Response(null, { status: 429 }), 'unexpected-status'],
        [
            'a 302',
            () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test/' } }),
            'unexpected-status',
        ],
        ['invalid JSON', () => new Response('{"enginePublicKey":', { status: 200 }), 'invalid-body'],
        ['invalid UTF-8', () => new Response(Uint8Array.of(0xff, 0xfe), { status: 200 }), 'invalid-body'],
        [
            'a body failing the schema',
            () => json({ enginePublicKey: 'x', hostnames: [], claims: [], status: 'gone' }),
            'invalid-body',
        ],
        ['a body over the size cap', () => json({ pad: 'x'.repeat(70_000) }), 'invalid-body'],
        ['an empty 200', () => new Response(null, { status: 200 }), 'invalid-body'],
        ['a network error', () => 'network', 'network'],
    ])('answers %s as unavailable and logs the kind only', async (_, answer, kind) => {
        fake.answer(answer);
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'unavailable' });
        expect(failures()).toEqual([
            { level: 'error', event: 'registry.error', fields: { engineId: engine.engineId, kind } },
        ]);
        expect(JSON.stringify(deps.logger.entries)).not.toContain(TOKEN);
    });

    it('answers a dashboard slower than the timeout as unavailable', async () => {
        fake.answer(() => 'hang');
        const lookup = registry.lookup(engine.engineId, signal);
        deps.clock.advance(TIMEOUT_MS);
        await expect(lookup).resolves.toEqual({ kind: 'unavailable' });
        expect(failures()[0]?.fields).toEqual({ engineId: engine.engineId, kind: 'timeout' });
    });

    it('rejects with the caller abort reason, mid-request too', async () => {
        fake.answer(() => 'hang');
        const controller = new AbortController();
        const reason = new Error('relay stopping');
        const lookup = registry.lookup(engine.engineId, controller.signal);
        controller.abort(reason);
        await expect(lookup).rejects.toBe(reason);
        expect(failures()).toEqual([]);
    });

    describe('wrapped by createCachedRegistry', () => {
        let cached: EngineRegistry;
        beforeEach(() => {
            cached = createCachedRegistry({
                inner: registry,
                clock: deps.clock,
                logger: deps.logger,
                ttlMs: TTL_MS,
                maxStaleMs: MAX_STALE_MS,
                negativeTtlMs: 30_000,
                lookupTimeoutMs: TIMEOUT_MS,
            });
        });

        it('serves a fresh entry without a request', async () => {
            serving(engine.entry);
            await cached.lookup(engine.engineId, signal);
            deps.clock.advance(TTL_MS - 1);
            await expect(cached.lookup(engine.engineId, signal)).resolves.toEqual({
                kind: 'found',
                entry: engine.entry,
            });
            expect(fake.calls).toHaveLength(1);
        });

        it('serves the last good entry while the dashboard is down, up to 24 h, then unavailable', async () => {
            serving(engine.entry);
            await cached.lookup(engine.engineId, signal);
            fake.answer(() => new Response(null, { status: 503 }));
            deps.clock.advance(MAX_STALE_MS - 1);
            await expect(cached.lookup(engine.engineId, signal)).resolves.toEqual({
                kind: 'found',
                entry: engine.entry,
            });
            deps.clock.advance(1);
            await expect(cached.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'unavailable' });
        });

        it('makes one request for ten concurrent lookups', async () => {
            serving(engine.entry);
            const lookups = await Promise.all(Array.from({ length: 10 }, () => cached.lookup(engine.engineId, signal)));
            expect(lookups.every((lookup) => lookup.kind === 'found')).toBe(true);
            expect(fake.calls).toHaveLength(1);
        });

        it('refuses a tunnel whose entry key differs from the key that signed the auth as auth-failed', async () => {
            const impostor = await createTestEngine(61);
            serving(impostor.entry);
            const relayId = RelayId.parse('relay-a.ptbk.test');
            const { challenge } = createChallenge(createFakeRandom(), relayId, {
                versions: [1],
                features: TUNNEL_FEATURES,
            });
            const signed = await signTunnelAuth(
                engine.signer,
                challenge,
                { version: EngineVersion.parse('1.0.0'), protocolVersions: [1], features: [] },
                { dialledRelayId: relayId },
            );
            if (signed.kind !== 'signed') throw new Error('expected a signed auth');
            const outcome = await verifyAuth({
                auth: JSON.stringify(signed.auth),
                challenge,
                registry: cached,
                dns: deps.dns,
                engineDomain: ENGINE_DOMAIN,
                logger: deps.logger,
                signal,
            });
            expect(outcome.kind === 'rejected' && toWireRejection(outcome.reason).message?.reason).toBe('auth-failed');
        });

        it('routes a custom hostname with a good claim and drops one with a bad claim', async () => {
            const other = await createTestEngine(62, [forged]);
            const entry: RegistryEntry = {
                ...engine.entry,
                hostnames: [...engine.entry.hostnames, forged],
                claims: [...engine.entry.claims, ...other.entry.claims],
            };
            serving(entry);
            const target = expectedCnameTarget(engine.engineId, ENGINE_DOMAIN);
            deps.dns.setAnswer(agents, { kind: 'cname', target });
            deps.dns.setAnswer(forged, { kind: 'cname', target });
            const lookup = await cached.lookup(engine.engineId, signal);
            if (lookup.kind !== 'found') throw new Error('expected an entry');
            await expect(
                routableHostnames({
                    engineId: engine.engineId,
                    entry: lookup.entry,
                    engineDomain: ENGINE_DOMAIN,
                    dns: deps.dns,
                    logger: deps.logger,
                    signal,
                }),
            ).resolves.toEqual([engine.defaultHostname, agents]);
        });
    });
});
