import type { Hostname, TunnelCloseCode } from '@ptbk/protocol';
import { Hostname as HostnameSchema, TUNNEL_CLOSE_CODE, expectedCnameTarget } from '@ptbk/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TestEngine } from '../../testing/engines';
import { ENGINE_DOMAIN, createTestEngine } from '../../testing/engines';
import type { TestDeps } from '../../testing/test-deps';
import { createTestDeps } from '../../testing/test-deps';
import { createCachedRegistry } from '../cached-registry';
import type { EngineRegistry } from '../engine-registry';
import type { Revalidator } from './revalidation';
import { createRevalidator } from './revalidation';
import type { SessionTable, TableSession } from './session-table';
import { createSessionTable } from './session-table';

const TTL_MS = 300_000;
const MAX_STALE_MS = 86_400_000;
const agents = HostnameSchema.parse('agents.customer.test');

interface FakeSession extends TableSession {
    readonly closes: TunnelCloseCode[];
}

describe('createRevalidator', () => {
    let deps: TestDeps;
    let engine: TestEngine;
    let registry: EngineRegistry;
    let table: SessionTable<FakeSession>;
    let session: FakeSession;
    let revalidator: Revalidator;

    const createSession = (from: TestEngine): FakeSession => {
        const closes: TunnelCloseCode[] = [];
        const created: FakeSession = {
            engineId: from.engineId,
            remoteIp: '198.51.100.1',
            closes,
            close(code) {
                closes.push(code);
                table.remove(created);
            },
        };
        return created;
    };
    const revalidatorOver = (source: EngineRegistry): Revalidator =>
        createRevalidator({
            clock: deps.clock,
            intervalMs: TTL_MS,
            table,
            registry: source,
            dns: deps.dns,
            engineDomain: ENGINE_DOMAIN,
            logger: deps.logger,
        });
    /** Lets the cached entry expire, then runs one round to completion. */
    const round = async (ms = TTL_MS): Promise<void> => {
        deps.clock.advance(ms);
        await revalidator.runOnce();
    };
    const pointCname = (hostname: Hostname, at: TestEngine): void => {
        deps.dns.setAnswer(hostname, { kind: 'cname', target: expectedCnameTarget(at.engineId, ENGINE_DOMAIN) });
    };

    beforeEach(async () => {
        deps = createTestDeps();
        engine = await createTestEngine(60, [agents]);
        deps.registry.set(engine.engineId, engine.entry);
        // As the relay wires it: revalidation sees the registry only through the cache.
        registry = createCachedRegistry({
            inner: deps.registry,
            clock: deps.clock,
            logger: deps.logger,
            ttlMs: TTL_MS,
            maxStaleMs: MAX_STALE_MS,
            negativeTtlMs: 30_000,
            lookupTimeoutMs: 3_000,
        });
        await registry.lookup(engine.engineId, new AbortController().signal);
        table = createSessionTable<FakeSession>({ logger: deps.logger });
        session = createSession(engine);
        table.register(session, [engine.defaultHostname]);
        revalidator = revalidatorOver(registry);
    });

    it('closes a suspended engine with SUSPENDED at the next round', async () => {
        deps.registry.set(engine.engineId, { ...engine.entry, status: 'suspended' });
        await round(TTL_MS - 1);
        expect(session.closes).toEqual([]);
        await round(1);
        expect(session.closes).toEqual([TUNNEL_CLOSE_CODE.SUSPENDED]);
        expect(table.byEngine(engine.engineId)).toBeUndefined();
        expect(deps.logger.entries).toContainEqual({
            level: 'warn',
            event: 'tunnel.revoked',
            fields: { engineId: engine.engineId, reason: 'suspended' },
        });
    });

    it('closes an engine removed from the registry with AUTH_FAILED', async () => {
        deps.registry.delete(engine.engineId);
        await round();
        expect(session.closes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
    });

    it('keeps the tunnel through a registry outage shorter than 24 hours and closes it after', async () => {
        deps.registry.setMode('unavailable');
        for (let elapsed = TTL_MS; elapsed < MAX_STALE_MS; elapsed += TTL_MS) {
            await round();
            expect(session.closes).toEqual([]);
        }
        expect(deps.logger.entries.some((entry) => entry.event === 'registry.stale')).toBe(true);
        await round();
        expect(session.closes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
        expect(deps.logger.entries).toContainEqual({
            level: 'warn',
            event: 'tunnel.revoked',
            fields: { engineId: engine.engineId, reason: 'unavailable' },
        });
    });

    it('closes an engine whose registry key no longer derives its ID with AUTH_FAILED', async () => {
        const other = await createTestEngine(61);
        deps.registry.set(engine.engineId, other.entry);
        await round();
        expect(session.closes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
    });

    it('recomputes routable hostnames from claims and the CNAME check', async () => {
        pointCname(agents, engine);
        await round();
        expect(table.hostnamesOf(session)).toEqual([engine.defaultHostname, agents]);
        expect(table.byHostname(agents)).toBe(session);
        deps.dns.setAnswer(agents, { kind: 'none' });
        await round();
        expect(table.hostnamesOf(session)).toEqual([engine.defaultHostname]);
        expect(JSON.stringify(deps.logger.entries)).not.toContain(agents);
    });

    it('updates at most 32 hostnames, the default one first', async () => {
        const customs = Array.from({ length: 32 }, (_, index) =>
            HostnameSchema.parse(`h${String(index)}.customer.test`),
        );
        const crowded = await createTestEngine(60, customs);
        deps.registry.set(engine.engineId, { ...crowded.entry, hostnames: customs });
        for (const hostname of customs) pointCname(hostname, engine);
        await round();
        expect(table.hostnamesOf(session)).toEqual([engine.defaultHostname, ...customs.slice(0, 31)]);
    });

    it('leaves a session alone that was replaced while its lookup ran', async () => {
        let answer: () => void = () => undefined;
        const gated: EngineRegistry = {
            lookup: (engineId, signal) =>
                new Promise((resolve) => {
                    answer = () => {
                        resolve(registry.lookup(engineId, signal));
                    };
                }),
        };
        deps.registry.delete(engine.engineId);
        deps.clock.advance(TTL_MS);
        const pending = revalidatorOver(gated).runOnce();
        const replacement = createSession(engine);
        table.register(replacement, [engine.defaultHostname]);
        answer();
        await pending;
        expect(replacement.closes).toEqual([]);
        expect(table.byEngine(engine.engineId)).toBe(replacement);
    });

    it('does not apply hostnames to a session replaced while its CNAME check ran', async () => {
        let answer: () => void = () => undefined;
        const gatedDns = {
            resolveCname: () =>
                new Promise<Awaited<ReturnType<typeof deps.dns.resolveCname>>>((resolve) => {
                    answer = () => {
                        resolve({ kind: 'cname', target: expectedCnameTarget(engine.engineId, ENGINE_DOMAIN) });
                    };
                }),
        };
        const gatedRevalidator = createRevalidator({
            clock: deps.clock,
            intervalMs: TTL_MS,
            table,
            registry,
            dns: gatedDns,
            engineDomain: ENGINE_DOMAIN,
            logger: deps.logger,
        });
        deps.clock.advance(TTL_MS);
        const pending = gatedRevalidator.runOnce();
        await vi.waitFor(() => {
            expect(deps.registry.calls()).toBe(2);
        });
        const replacement = createSession(engine);
        table.register(replacement, [engine.defaultHostname]);
        await vi.waitFor(() => {
            answer();
            expect(table.hostnamesOf(replacement)).toEqual([engine.defaultHostname]);
        });
        await pending;
        expect(table.hostnamesOf(replacement)).toEqual([engine.defaultHostname]);
    });

    it('runs a round every interval until stopped', async () => {
        deps.registry.set(engine.engineId, { ...engine.entry, status: 'suspended' });
        revalidator.start();
        revalidator.start();
        expect(deps.clock.pendingTimers()).toBe(1);
        deps.clock.advance(TTL_MS);
        await vi.waitFor(() => {
            expect(session.closes).toEqual([TUNNEL_CLOSE_CODE.SUSPENDED]);
        });
        await vi.waitFor(() => {
            expect(deps.clock.pendingTimers()).toBe(1);
        });
        revalidator.stop();
        expect(deps.clock.pendingTimers()).toBe(0);
    });

    it('aborts the running round on stop and never runs two chains after a restart', async () => {
        let lookups = 0;
        let answer: () => void = () => undefined;
        const gated: EngineRegistry = {
            lookup: (_, signal) => {
                lookups++;
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(signal.reason as Error);
                    });
                    answer = () => {
                        resolve({ kind: 'found', entry: engine.entry });
                    };
                });
            },
        };
        const scheduled = revalidatorOver(gated);
        scheduled.start();
        deps.clock.advance(TTL_MS);
        expect(lookups).toBe(1);
        scheduled.stop();
        scheduled.start();
        answer();
        await vi.waitFor(() => {
            expect(deps.clock.pendingTimers()).toBe(1);
        });
        deps.clock.advance(TTL_MS);
        expect(lookups).toBe(2);
        answer();
        await vi.waitFor(() => {
            expect(deps.clock.pendingTimers()).toBe(1);
        });
        deps.clock.advance(TTL_MS);
        expect(lookups).toBe(3);
        scheduled.stop();
        expect(session.closes).toEqual([]);
    });
});
