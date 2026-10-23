import type { EngineId, TunnelChallenge } from '@ptbk/protocol';
import {
    FrameType,
    RelayId,
    TUNNEL_CLOSE_CODE,
    TunnelChallenge as TunnelChallengeSchema,
    encodeFrame,
    signTunnelAuth,
} from '@ptbk/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ENGINE_VERSION } from '../../testing/engine-client';
import type { TestEngine } from '../../testing/engines';
import { ENGINE_DOMAIN, createTestEngine } from '../../testing/engines';
import type { FakeConnection } from '../../testing/fake-connection';
import { createFakeConnection } from '../../testing/fake-connection';
import { createFakeRandom } from '../../testing/fake-random';
import type { TestDeps } from '../../testing/test-deps';
import { createTestDeps } from '../../testing/test-deps';
import type { TunnelTerminationReason } from '../metrics/reason-counters';
import type { SessionTable } from './session-table';
import { createSessionTable } from './session-table';
import type { ConnectionEvents, PendingConnection, TunnelEndpoint, TunnelEndpointLimits } from './tunnel-endpoint';
import { REJECT_LINGER_MS, createTunnelEndpoint } from './tunnel-endpoint';
import type { TunnelSession } from './tunnel-session';

const RELAY_ID = RelayId.parse('relay-a.ptbk.test');
const IP = '198.51.100.7';
const TIMEOUT_MS = 10_000;
const LIMITS: TunnelEndpointLimits = {
    handshakeTimeoutMs: TIMEOUT_MS,
    maxPending: 1000,
    maxPendingPerIp: 10,
    maxTunnelsPerIp: 50,
    registryMissesPerS: 20,
    session: { framesPerS: 1000, minWindowIncrementBytes: 1024 },
};

interface Attached {
    readonly connection: FakeConnection;
    readonly events: ConnectionEvents;
    readonly pending: PendingConnection;
}

describe('createTunnelEndpoint', () => {
    let deps: TestDeps;
    let engine: TestEngine;
    let table: SessionTable<TunnelSession>;
    let endpoint: TunnelEndpoint;
    let abandoned: number;
    let cached: Set<EngineId>;
    let terminated: TunnelTerminationReason[];

    const create = (
        limits: Partial<TunnelEndpointLimits> = {},
        sessions: SessionTable<TunnelSession> = table,
    ): TunnelEndpoint =>
        createTunnelEndpoint({
            relayId: RELAY_ID,
            engineDomain: ENGINE_DOMAIN,
            offer: { versions: [1], features: [] },
            registry: {
                lookup: (engineId, signal) => deps.registry.lookup(engineId, signal),
                has: (engineId) => cached.has(engineId),
            },
            dns: deps.dns,
            random: createFakeRandom(),
            clock: deps.clock,
            logger: deps.logger,
            limits: { ...LIMITS, ...limits },
            table: sessions,
            terminations: { count: (reason) => terminated.push(reason) },
            metrics: deps.metrics,
        });
    const accept = (ip = IP): PendingConnection => {
        const pending = endpoint.accept(ip, () => {
            abandoned++;
        });
        if (pending === null) throw new Error('expected the connection to be admitted');
        return pending;
    };
    const attach = (ip = IP): Attached => {
        const pending = accept(ip);
        const connection = createFakeConnection();
        return { connection, events: pending.attach(connection), pending };
    };
    const challengeOf = (connection: FakeConnection): TunnelChallenge =>
        TunnelChallengeSchema.parse(connection.messages()[0]);
    const authText = async (challenge: TunnelChallenge, from: TestEngine = engine): Promise<string> => {
        const signed = await signTunnelAuth(
            from.signer,
            challenge,
            { version: ENGINE_VERSION, protocolVersions: [1], features: [] },
            { dialledRelayId: RELAY_ID },
        );
        if (signed.kind !== 'signed') throw new Error('expected a signed auth');
        return JSON.stringify(signed.auth);
    };
    const authenticate = async (attached: Attached, from: TestEngine = engine): Promise<void> => {
        attached.events.text(await authText(challengeOf(attached.connection), from));
    };
    const ready = async (from: TestEngine = engine, ip = IP): Promise<Attached> => {
        const attached = attach(ip);
        await authenticate(attached, from);
        await vi.waitFor(() => {
            expect(attached.connection.messages()).toHaveLength(2);
        });
        return attached;
    };
    const rejected = (fields: Record<string, unknown>): unknown =>
        expect.objectContaining({
            level: 'warn',
            event: 'tunnel.rejected',
            fields: expect.objectContaining(fields) as unknown,
        }) as unknown;

    beforeEach(async () => {
        deps = createTestDeps();
        engine = await createTestEngine(70);
        deps.registry.set(engine.engineId, engine.entry);
        table = createSessionTable<TunnelSession>({ logger: deps.logger });
        abandoned = 0;
        cached = new Set();
        terminated = [];
        endpoint = create();
    });

    it('sends a fresh challenge, answers a valid auth with ready and registers the session', async () => {
        const first = await ready();
        expect(first.connection.messages()).toEqual([
            {
                v: 1,
                type: 'challenge',
                nonce: expect.any(String) as unknown,
                relayId: RELAY_ID,
                protocolVersions: [1],
                features: [],
            },
            { v: 1, type: 'ready', protocolVersion: 1, features: [], hostnames: [engine.defaultHostname] },
        ]);
        const session = table.byEngine(engine.engineId);
        expect(session).toMatchObject({ engineId: engine.engineId, remoteIp: IP, protocolVersion: 1 });
        expect(table.byHostname(engine.defaultHostname)).toBe(session);
        expect(deps.logger.entries).toEqual([
            {
                level: 'info',
                event: 'tunnel.connected',
                fields: { engineId: engine.engineId, engineIp: IP, relayId: RELAY_ID },
            },
        ]);
        expect(first.connection.closes).toEqual([]);
        const second = attach();
        expect(challengeOf(second.connection).nonce).not.toBe(challengeOf(first.connection).nonce);
        // The deadline was cancelled at ready.
        deps.clock.advance(TIMEOUT_MS);
        expect(first.connection.closes).toEqual([]);
    });

    it('never logs nonces, signatures, keys or payload bytes', async () => {
        const attached = attach();
        const challenge = challengeOf(attached.connection);
        const auth = await authText(challenge);
        attached.events.text(auth);
        await vi.waitFor(() => {
            expect(attached.connection.messages()).toHaveLength(2);
        });
        attached.events.binary(
            encodeFrame({
                type: FrameType.OPEN,
                streamId: 1 as never,
                family: 4,
                address: Uint8Array.of(1, 2, 3, 4),
                port: 9,
            }),
        );
        const failed = attach();
        failed.events.text(auth);
        await vi.waitFor(() => {
            expect(failed.connection.closes).toHaveLength(1);
        });
        const logged = JSON.stringify(deps.logger.entries);
        const { sig } = JSON.parse(auth) as { sig: string };
        for (const secret of [
            challenge.nonce,
            challengeOf(failed.connection).nonce,
            sig,
            engine.entry.enginePublicKey,
        ]) {
            expect(logged).not.toContain(secret);
        }
    });

    it.each([
        ['unknown-engine', 'auth-failed', TUNNEL_CLOSE_CODE.AUTH_FAILED],
        ['suspended', 'suspended', TUNNEL_CLOSE_CODE.SUSPENDED],
    ] as const)('refuses %s with %s', async (reason, wireReason, closeCode) => {
        if (reason === 'unknown-engine') deps.registry.delete(engine.engineId);
        else deps.registry.set(engine.engineId, { ...engine.entry, status: 'suspended' });
        const attached = attach();
        await authenticate(attached);
        await vi.waitFor(() => {
            expect(attached.connection.closes).toEqual([closeCode]);
        });
        expect(attached.connection.messages()[1]).toEqual({ v: 1, type: 'reject', reason: wireReason });
        expect(deps.logger.entries).toEqual([
            rejected({ engineId: engine.engineId, engineIp: IP, relayId: RELAY_ID, reason, closeCode }),
        ]);
        expect(table.sessions()).toEqual([]);
    });

    it('refuses a forged signature as auth-failed', async () => {
        const forger = await createTestEngine(71);
        const attached = attach();
        const forged = JSON.parse(await authText(challengeOf(attached.connection), forger)) as Record<string, unknown>;
        attached.events.text(JSON.stringify({ ...forged, engineId: engine.engineId }));
        await vi.waitFor(() => {
            expect(attached.connection.closes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
        });
        expect(attached.connection.messages()[1]).toEqual({ v: 1, type: 'reject', reason: 'auth-failed' });
        expect(deps.logger.entries).toEqual([rejected({ reason: 'bad-signature' })]);
        expect(deps.metrics.total('ptbk_relay_tunnel_handshake_failures_total', { reason: 'bad-signature' })).toBe(1);
        expect(deps.metrics.total('ptbk_relay_tunnel_connects_total')).toBe(0);
    });

    it('refuses as auth-failed when the registry throws', async () => {
        deps.registry.setMode('throw');
        const attached = attach();
        await authenticate(attached);
        await vi.waitFor(() => {
            expect(attached.connection.closes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
        });
        expect(deps.logger.entries).toEqual([rejected({ reason: 'registry-unavailable' })]);
        expect(deps.logger.entries[0]?.fields).not.toHaveProperty('engineId');
    });

    it('closes malformed auth with PROTOCOL_ERROR and no reject', async () => {
        const attached = attach();
        attached.events.text('{"v":1,"type":"auth"}');
        await vi.waitFor(() => {
            expect(attached.connection.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        });
        expect(attached.connection.messages()).toHaveLength(1);
        expect(deps.logger.entries).toEqual([rejected({ reason: 'malformed' })]);
    });

    it('closes a binary message before ready with PROTOCOL_ERROR and no reject', () => {
        const attached = attach();
        attached.events.binary(Uint8Array.of(1));
        expect(attached.connection.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(attached.connection.messages()).toHaveLength(1);
        attached.events.binary(Uint8Array.of(1));
        attached.events.text('{}');
        attached.events.closed(1006);
        expect(attached.connection.closes).toHaveLength(1);
    });

    it('closes a second message while auth is verified as malformed and ignores the late answer', async () => {
        deps.registry.setMode('hang');
        const attached = attach();
        await authenticate(attached);
        attached.events.binary(Uint8Array.of(1));
        expect(attached.connection.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        const again = attach();
        await authenticate(again);
        again.events.text('{}');
        expect(again.connection.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(table.sessions()).toEqual([]);
    });

    it('drops a socket that has not upgraded by the deadline, counted from TCP accept', () => {
        const pending = accept();
        deps.clock.advance(TIMEOUT_MS - 1);
        expect(abandoned).toBe(0);
        deps.clock.advance(1);
        expect(abandoned).toBe(1);
        const connection = createFakeConnection();
        pending.attach(connection);
        expect(connection.closes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
        expect(connection.texts).toEqual([]);
    });

    it('counts the deadline from the accept time the listener recorded, before the hand-off', () => {
        const acceptedAtMs = deps.clock.nowMs();
        deps.clock.advance(TIMEOUT_MS - 10);
        const upgraded = createFakeConnection();
        endpoint.accept(IP, () => abandoned++, acceptedAtMs)?.attach(upgraded);
        const late = endpoint.accept(IP, () => abandoned++, acceptedAtMs - TIMEOUT_MS);
        expect(late).not.toBeNull();
        deps.clock.advance(9);
        expect(upgraded.closes).toEqual([]);
        expect(abandoned).toBe(1);
        deps.clock.advance(1);
        expect(upgraded.messages()[1]).toEqual({ v: 1, type: 'reject', reason: 'timeout' });
        expect(upgraded.closes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
    });

    it('rejects with timeout and AUTH_FAILED when no auth arrives in time', () => {
        const attached = attach();
        deps.clock.advance(TIMEOUT_MS);
        expect(attached.connection.messages()[1]).toEqual({ v: 1, type: 'reject', reason: 'timeout' });
        expect(attached.connection.closes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
        expect(abandoned).toBe(0);
    });

    it('rejects with timeout while the registry is still answering, and ignores the late answer', async () => {
        deps.registry.setMode('hang');
        const attached = attach();
        await authenticate(attached);
        deps.clock.advance(TIMEOUT_MS);
        expect(attached.connection.closes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
        await vi.waitFor(() => {
            expect(deps.logger.entries).toHaveLength(1);
        });
        expect(table.sessions()).toEqual([]);
    });

    it('ignores an answer that arrives after the connection closed', async () => {
        const attached = attach();
        await authenticate(attached);
        attached.events.closed(1006);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(attached.connection.messages()).toHaveLength(1);
        expect(table.sessions()).toEqual([]);
    });

    it('refuses the 11th pending handshake from one IP with rate-limited and 1013', () => {
        for (let index = 0; index < LIMITS.maxPendingPerIp; index++) accept();
        const limited = attach();
        expect(limited.connection.messages()).toEqual([{ v: 1, type: 'reject', reason: 'rate-limited' }]);
        expect(limited.connection.closes).toEqual([1013]);
        expect(attach('198.51.100.8').connection.closes).toEqual([]);
    });

    it('refuses past the global pending limit and drops once the rejects are at the limit too', () => {
        endpoint = create({ maxPending: 2 });
        accept('192.0.2.1');
        accept('192.0.2.2');
        expect(attach('192.0.2.3').connection.closes).toEqual([1013]);
        // The refused one holds its slot until its socket is gone; one more fills the rate-limited pool.
        accept('192.0.2.4');
        expect(endpoint.accept('192.0.2.5', () => undefined)).toBeNull();
    });

    it('frees a pending slot when the socket closes before the upgrade', () => {
        endpoint = create({ maxPendingPerIp: 1 });
        accept().socketClosed();
        expect(attach().connection.closes).toEqual([]);
    });

    it('refuses a tunnel past the per-IP tunnel limit with rate-limited', async () => {
        endpoint = create({ maxTunnelsPerIp: 1 });
        await ready();
        const limited = attach();
        expect(limited.connection.messages()).toEqual([{ v: 1, type: 'reject', reason: 'rate-limited' }]);
        expect(limited.connection.closes).toEqual([1013]);
    });

    it('routes binary frames to the session and closes it on text after ready', async () => {
        const first = await ready();
        first.events.binary(encodeFrame({ type: FrameType.WINDOW, streamId: 1 as never, increment: 1 }));
        expect(first.connection.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        const second = await ready();
        second.events.text('{}');
        expect(second.connection.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(table.sessions()).toEqual([]);
    });

    it('logs tunnel.disconnected with the close code and forgets the session', async () => {
        const attached = await ready();
        attached.events.closed(1001);
        attached.events.closed(1006);
        attached.pending.socketClosed();
        expect(table.sessions()).toEqual([]);
        expect(deps.logger.entries.at(-1)).toEqual({
            level: 'info',
            event: 'tunnel.disconnected',
            fields: { engineId: engine.engineId, engineIp: IP, relayId: RELAY_ID, closeCode: 1001 },
        });
        expect(deps.metrics.total('ptbk_relay_tunnel_connects_total')).toBe(1);
        expect(deps.metrics.total('ptbk_relay_tunnel_disconnects_total')).toBe(1);
        expect(deps.metrics.total('ptbk_relay_tunnel_disconnects_total', { code: 'going-away' })).toBe(1);
        expect(JSON.stringify(deps.metrics.records)).not.toMatch(new RegExp(`${engine.engineId}|${IP}`));
    });

    it('replaces an older tunnel of the same engine with REPLACED', async () => {
        const older = await ready();
        const newer = await ready();
        expect(older.connection.closes).toEqual([TUNNEL_CLOSE_CODE.REPLACED]);
        expect(table.byEngine(engine.engineId)).toBeDefined();
        expect(newer.connection.closes).toEqual([]);
        older.events.closed(TUNNEL_CLOSE_CODE.REPLACED);
        expect(table.sessions()).toHaveLength(1);
    });

    it('ends handshakes quietly when the WebSocket closes', async () => {
        endpoint = create({ maxPendingPerIp: 2 });
        const waiting = attach();
        waiting.events.closed(1006);
        waiting.pending.socketClosed();
        deps.registry.setMode('hang');
        const verifying = attach();
        await authenticate(verifying);
        verifying.events.closed(1006);
        verifying.pending.socketClosed();
        expect(attach().connection.closes).toEqual([]);
        deps.clock.advance(TIMEOUT_MS);
        expect(waiting.connection.closes).toEqual([]);
        expect(verifying.connection.closes).toEqual([]);
    });

    it('shuts down every stage with SHUTTING_DOWN and refuses new connections', async () => {
        const live = await ready(engine);
        const preUpgrade = accept('192.0.2.1');
        const awaiting = attach('192.0.2.2');
        deps.registry.setMode('hang');
        const verifying = attach('192.0.2.3');
        await authenticate(verifying);
        endpoint.shutdown();
        expect(live.connection.closes).toEqual([TUNNEL_CLOSE_CODE.SHUTTING_DOWN]);
        expect(awaiting.connection.closes).toEqual([TUNNEL_CLOSE_CODE.SHUTTING_DOWN]);
        expect(verifying.connection.closes).toEqual([TUNNEL_CLOSE_CODE.SHUTTING_DOWN]);
        expect(abandoned).toBe(1);
        const late = createFakeConnection();
        preUpgrade.attach(late);
        expect(late.closes).toEqual([TUNNEL_CLOSE_CODE.SHUTTING_DOWN]);
        expect(endpoint.accept(IP, () => undefined)).toBeNull();
        expect(table.sessions()).toEqual([]);
    });

    describe('handshake limits', () => {
        it("holds a refused connection's slot until its socket closes, and destroys the socket after the linger", async () => {
            endpoint = create({ maxPendingPerIp: 1 });
            const refused = attach();
            refused.events.text('not json');
            await vi.waitFor(() => {
                expect(refused.connection.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
            });
            // Still closing: the next handshake from that IP is refused too.
            const waiting = attach();
            expect(waiting.connection.closes).toEqual([1013]);
            deps.clock.advance(REJECT_LINGER_MS - 1);
            expect(abandoned).toBe(0);
            deps.clock.advance(1);
            expect(abandoned).toBe(2);
            refused.pending.socketClosed();
            waiting.pending.socketClosed();
            expect(attach().connection.closes).toEqual([]);
        });

        it('frees the slot once the refused socket is gone, and cancels its linger', () => {
            endpoint = create({ maxPendingPerIp: 1 });
            const refused = attach();
            refused.events.binary(Uint8Array.of(1));
            refused.pending.socketClosed();
            deps.clock.advance(REJECT_LINGER_MS);
            expect(abandoned).toBe(0);
            expect(attach().connection.closes).toEqual([]);
        });

        it('counts pending handshakes and tunnels per IPv6 /64', async () => {
            endpoint = create({ maxPendingPerIp: 1, maxTunnelsPerIp: 1 });
            const first = await ready(engine, '2001:db8:1:2::1');
            expect(first.connection.closes).toEqual([]);
            const sameSlash64 = attach('2001:db8:1:2::ffff');
            expect(sameSlash64.connection.messages()).toEqual([{ v: 1, type: 'reject', reason: 'rate-limited' }]);
            expect(attach('2001:db8:1:3::1').connection.closes).toEqual([]);
            expect(attach('2001:db8:1:3::2').connection.closes).toEqual([1013]);
        });

        it('refuses handshakes whose engine is not cached as rate-limited once the miss budget is spent', async () => {
            endpoint = create({ registryMissesPerS: 2 });
            const other = await createTestEngine(72);
            deps.registry.set(other.engineId, other.entry);
            const misses = [attach(), attach(), attach()];
            for (const attached of misses) await authenticate(attached);
            await vi.waitFor(() => {
                expect(misses[2]?.connection.closes).toEqual([1013]);
            });
            expect(misses[2]?.connection.messages()[1]).toEqual({ v: 1, type: 'reject', reason: 'rate-limited' });
            expect(deps.registry.calls()).toBe(2);
            // A cached engine never spends the budget; an uncached one waits for it to refill.
            cached.add(engine.engineId);
            const hit = attach();
            await authenticate(hit);
            const miss = attach();
            await authenticate(miss, other);
            await vi.waitFor(() => {
                expect(miss.connection.closes).toEqual([1013]);
            });
            await vi.waitFor(() => {
                expect(hit.connection.messages()[1]).toMatchObject({ type: 'ready' });
            });
            deps.clock.advance(500);
            const later = attach();
            await authenticate(later, other);
            await vi.waitFor(() => {
                expect(later.connection.messages()[1]).toMatchObject({ type: 'ready' });
            });
        });
    });

    describe('a bug after verification', () => {
        it('closes the tunnel it just registered with PROTOCOL_ERROR', async () => {
            const throwing: SessionTable<TunnelSession> = {
                ...table,
                register() {
                    throw new TypeError('bug');
                },
            };
            endpoint = create({}, throwing);
            const attached = attach();
            await authenticate(attached);
            await vi.waitFor(() => {
                expect(attached.connection.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
            });
            expect(deps.logger.entries).toContainEqual({
                level: 'error',
                event: 'tunnel.failed',
                fields: { problem: 'TypeError' },
            });
            expect(terminated).toEqual(['failed']);
        });

        it('closes the handshake with PROTOCOL_ERROR and lets the socket go after the linger', async () => {
            endpoint = create({ session: { framesPerS: 0, minWindowIncrementBytes: 1024 } });
            const attached = attach();
            await authenticate(attached);
            await vi.waitFor(() => {
                expect(attached.connection.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
            });
            expect(table.sessions()).toEqual([]);
            deps.clock.advance(REJECT_LINGER_MS);
            expect(abandoned).toBe(1);
        });

        it('logs only the kind of a thrown value that is not an Error', async () => {
            const throwing: SessionTable<TunnelSession> = {
                ...table,
                register() {
                    // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw is the case
                    throw 'detail that may quote input';
                },
            };
            endpoint = create({}, throwing);
            await authenticate(attach());
            await vi.waitFor(() => {
                expect(deps.logger.entries).toContainEqual({
                    level: 'error',
                    event: 'tunnel.failed',
                    fields: { problem: 'unknown' },
                });
            });
        });
    });
});
