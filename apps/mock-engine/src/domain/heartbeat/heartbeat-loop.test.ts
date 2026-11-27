import type { HeartbeatAttention, SetupState, Timestamp } from '@ptbk/protocol';
import {
    EngineVersion,
    HEARTBEAT_MAX_BODY_BYTES,
    Heartbeat,
    Hostname,
    Timestamp as TimestampSchema,
    verifyHeartbeat,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createTestIdentity } from '../../testing/test-identity';
import { createMemoryRegistrationStore } from '../../testing/memory-registration-store';
import { createMemorySeqStore } from '../../testing/memory-seq-store';
import { createFakeClock } from '../../testing/fake-clock';
import type { FakeDashboard } from '../../testing/fake-dashboard';
import { createFakeDashboard } from '../../testing/fake-dashboard';
import { flush, until } from '../../testing/fake-dialer';
import { createMemoryLogger } from '../../testing/memory-logger';
import type { DashboardApi } from '../dashboard/dashboard-api';
import { registerEngine } from '../registration/register';
import { isoSeconds } from './build-heartbeat';
import type { HeartbeatStatus, HeartbeatTeams } from './heartbeat-loop';
import { DEFAULT_HEARTBEAT_INTERVAL_S, SETUP_CHECK_MS, createHeartbeatLoop } from './heartbeat-loop';
import { createScenarioSystemStats } from './scenario-system-stats';
import type { SeqStore } from './seq-store';

const START_MS = Date.parse('2026-10-20T08:00:00Z');
const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const VERSION = EngineVersion.parse('0.4.2');

interface SetupOptions {
    readonly intervalS?: number;
    readonly clockOffsetMs?: number;
    readonly seqs?: (fallback: SeqStore) => SeqStore;
    readonly api?: (fake: FakeDashboard) => DashboardApi;
    readonly teams?: HeartbeatTeams;
    readonly setup?: () => SetupState | null;
    readonly ownerHandoff?: () => boolean;
    readonly attention?: () => readonly HeartbeatAttention[] | null;
}

async function setup(options: SetupOptions = {}) {
    const clock = createFakeClock(START_MS);
    const logger = createMemoryLogger();
    const identity = await createTestIdentity();
    const fake = createFakeDashboard({
        clock,
        engineDomain: ENGINE_DOMAIN,
        relays: [Hostname.parse('relay-a.ptbk.test')],
        ...(options.clockOffsetMs === undefined ? {} : { clockOffsetMs: options.clockOffsetMs }),
    });
    const registered = await registerEngine({
        store: createMemoryRegistrationStore(),
        identity,
        dashboardUrl: 'https://dashboard.ptbk.test',
        engineDomain: ENGINE_DOMAIN,
        api: fake.api,
        engineVersion: VERSION,
        linkCode: fake.issueLinkCode('org-1'),
        logger,
        signal: new AbortController().signal,
    });
    expect(registered.kind).toBe('registered');
    const memorySeqs = createMemorySeqStore(clock);
    const statuses: HeartbeatStatus[] = [];
    const loop = createHeartbeatLoop({
        clock,
        logger,
        api: options.api?.(fake) ?? fake.api,
        seqs: options.seqs?.(memorySeqs) ?? memorySeqs,
        system: createScenarioSystemStats(() => 'small-team'),
        engine: {
            counts: () => ({ agents: 3, members: 2 }),
            updateState: () => 'none',
            setup: options.setup ?? (() => null),
        },
        identity,
        version: VERSION,
        intervalS: options.intervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S,
        startedAtMs: START_MS,
        onStatus: (status) => statuses.push(status),
        ...(options.teams === undefined ? {} : { teams: options.teams }),
        ...(options.ownerHandoff === undefined ? {} : { ownerHandoff: options.ownerHandoff }),
        ...(options.attention === undefined ? {} : { attention: options.attention }),
    });
    return { clock, logger, identity, fake, loop, statuses, memorySeqs };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Waits for the dashboard to have received `count` beats, then lets the loop finish handling the answer. */
async function received(started: Setup, count: number): Promise<void> {
    await until(() => started.fake.heartbeats.length >= count);
    await flush(5);
}

function seqOf(body: Uint8Array | string): number {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    return Heartbeat.parse(JSON.parse(text)).seq;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
    let resolve = (): void => undefined;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('createHeartbeatLoop: teams', () => {
    function fakeTeams(enabled: boolean) {
        const acked: string[][] = [];
        const applied: string[][] = [];
        let settled = 0;
        const teams: HeartbeatTeams = {
            enabled: () => enabled,
            settle: () => {
                settled++;
                return Promise.resolve();
            },
            pendingRequests: () => 2,
            acks: () => [{ id: 'ticket-0000000000000001', outcome: 'approved' }],
            acked: (ids) => acked.push([...ids]),
            applyRevocations: (tokens) => {
                applied.push([...tokens]);
                return Promise.resolve();
            },
        };
        return { teams, acked, applied, settled: () => settled };
    }

    it('sends v2 with the pending count and acks, clears the acks it delivered and applies the reply', async () => {
        const teams = fakeTeams(true);
        const started = await setup({ teams: teams.teams });
        started.fake.queueRevocation(started.identity.engineId, 'revocation-000000000001', 'body.signature');
        started.loop.start();
        await received(started, 1);
        const [beat] = started.fake.heartbeats;
        expect(beat?.verification).toMatchObject({
            kind: 'accepted',
            heartbeat: { v: 2, accessRequests: 2, acks: [{ id: 'ticket-0000000000000001', outcome: 'approved' }] },
        });
        expect(teams.settled()).toBe(1);
        expect(teams.acked).toEqual([['ticket-0000000000000001']]);
        expect(teams.applied).toEqual([['body.signature']]);
    });

    it('carries the attention counts in v2 while sharing is on, and no field at all while it is off', async () => {
        let attention: readonly HeartbeatAttention[] | null = [
            { to: 'dashboard-user-petr', kind: 'agent-waiting', count: 2 },
            { kind: 'tool-sign-in', count: 1 },
        ];
        const started = await setup({ teams: fakeTeams(true).teams, attention: () => attention });
        started.loop.start();
        await received(started, 1);
        expect(started.fake.heartbeats[0]?.verification).toMatchObject({ kind: 'accepted', heartbeat: { attention } });
        attention = null;
        started.loop.beatNow();
        await received(started, 2);
        const body = new TextDecoder().decode(started.fake.heartbeats[1]?.rawBody ?? new Uint8Array());
        expect(JSON.parse(body)).not.toHaveProperty('attention');
        await started.loop.stop();
    });

    it('never puts more than who, what kind and how many into the body, whatever the inbox holds', async () => {
        const rich = [
            { to: 'dashboard-user-petr', kind: 'agent-waiting', count: 1, title: 'Approve the March invoice' },
        ] as unknown as readonly HeartbeatAttention[];
        const started = await setup({ teams: fakeTeams(true).teams, attention: () => rich });
        started.loop.start();
        await received(started, 1);
        const body = new TextDecoder().decode(started.fake.heartbeats[0]?.rawBody ?? new Uint8Array());
        expect(body).not.toContain('invoice');
        expect((JSON.parse(body) as { attention: unknown }).attention).toEqual([
            { to: 'dashboard-user-petr', kind: 'agent-waiting', count: 1 },
        ]);
        await started.loop.stop();
    });

    it('stays on v1 until a member key is pinned', async () => {
        const teams = fakeTeams(false);
        const started = await setup({ teams: teams.teams });
        started.loop.start();
        await received(started, 1);
        expect(started.fake.heartbeats[0]?.verification).toMatchObject({ kind: 'accepted', heartbeat: { v: 1 } });
        expect(teams.acked).toEqual([]);
    });
});

describe('createHeartbeatLoop', () => {
    it('beats once on start and then every 60 s by default', async () => {
        expect(DEFAULT_HEARTBEAT_INTERVAL_S).toBe(60);
        const started = await setup();
        started.loop.start();
        await received(started, 1);
        started.clock.advance(59_000);
        await flush(10);
        expect(started.fake.heartbeats).toHaveLength(1);
        started.clock.advance(1_000);
        await received(started, 2);
        started.clock.advance(60_000);
        await received(started, 3);
        expect(started.fake.heartbeats).toHaveLength(3);
        await started.loop.stop();
    });

    it('beats every 15 s with an interval of 15', async () => {
        const started = await setup({ intervalS: 15 });
        started.loop.start();
        await received(started, 1);
        started.clock.advance(14_000);
        await flush(10);
        expect(started.fake.heartbeats).toHaveLength(1);
        started.clock.advance(1_000);
        await received(started, 2);
        started.clock.advance(15_000);
        await received(started, 3);
        await started.loop.stop();
    });

    it('starts only once', async () => {
        const started = await setup();
        started.loop.start();
        started.loop.start();
        await received(started, 1);
        started.clock.advance(60_000);
        await received(started, 2);
        expect(started.fake.heartbeats).toHaveLength(2);
        await started.loop.stop();
    });

    it("sends beats C-03's verifyHeartbeat accepts in order, refuses a replay of, and keeps under 4 KiB", async () => {
        const started = await setup();
        started.loop.start();
        await received(started, 1);
        for (let beat = 2; beat <= 4; beat++) {
            started.clock.advance(60_000);
            await received(started, beat);
        }
        const beats = started.fake.heartbeats;
        expect(beats.map((beat) => beat.verification.kind)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
        const seqs = beats.map((beat) => seqOf(beat.rawBody));
        for (let index = 1; index < seqs.length; index++) {
            expect(seqs[index]).toBeGreaterThan(seqs[index - 1] ?? Infinity);
        }
        for (const beat of beats) expect(beat.rawBody.length).toBeLessThan(HEARTBEAT_MAX_BODY_BYTES);
        const replayed = beats[1];
        if (replayed === undefined) throw new Error('no beat');
        const result = await verifyHeartbeat({
            rawBody: replayed.rawBody,
            signatureHeader: replayed.signature,
            engineId: started.identity.engineId,
            publicKey: started.identity.publicKey,
            lastSeq: seqs.at(-1) ?? null,
            now: isoSeconds(started.clock.nowMs()),
        });
        expect(result.kind).toBe('replayed-seq');
        await started.loop.stop();
    });

    it('keeps the exact last body and signature for the security panel and reports each as sent', async () => {
        const started = await setup();
        started.loop.start();
        await received(started, 1);
        started.clock.advance(60_000);
        await received(started, 2);
        const last = started.fake.heartbeats.at(-1);
        if (last === undefined) throw new Error('no beat');
        const text = new TextDecoder().decode(last.rawBody);
        const status = started.loop.status();
        expect(status.lastHeartbeat?.body).toBe(text);
        expect(status.lastHeartbeat?.signature).toBe(last.signature);
        expect(status.lastHeartbeat?.sentAt).toBe(isoSeconds(started.clock.nowMs()));
        expect(Heartbeat.parse(JSON.parse(text)).ts).toBe(status.lastHeartbeat?.sentAt);
        expect(new Set(started.statuses.map(({ lastHeartbeat }) => lastHeartbeat?.body)).size).toBe(2);
        expect(started.statuses.at(-1)).toEqual(status);
        expect(status.clockSkew).toBeNull();
        await started.loop.stop();
    });

    it('records a skew of -300 s from a stale-timestamp answer 5 minutes ahead', async () => {
        const started = await setup({ clockOffsetMs: 300_000 });
        started.loop.start();
        await received(started, 1);
        expect(started.fake.heartbeats[0]?.verification.kind).toBe('stale-ts');
        expect(started.loop.status().clockSkew).toEqual({
            seconds: -300,
            measuredAt: isoSeconds(started.clock.nowMs()),
        });
        expect(started.loop.status().lastHeartbeat).not.toBeNull();
        expect(started.statuses.at(-1)).toEqual(started.loop.status());
        const skewLogs = started.logger.entries.filter((entry) => entry.event === 'heartbeat.clock-skew');
        expect(skewLogs).toEqual([{ level: 'warn', event: 'heartbeat.clock-skew', fields: { seconds: -300 } }]);
        expect(started.logger.entries).toContainEqual({
            level: 'warn',
            event: 'heartbeat.refused',
            fields: { status: 401 },
        });
        await started.loop.stop();
    });

    it('leaves the skew unknown when the stale-timestamp answer has no serverTime', async () => {
        const started = await setup({ clockOffsetMs: 300_000 });
        started.fake.omitServerTime = true;
        started.loop.start();
        await received(started, 1);
        expect(started.fake.heartbeats[0]?.verification.kind).toBe('stale-ts');
        expect(started.loop.status().clockSkew).toBeNull();
        expect(started.logger.entries.some((entry) => entry.event === 'heartbeat.clock-skew')).toBe(false);
        await started.loop.stop();
    });

    it('clears the skew once a beat is accepted, and ignores other refusals', async () => {
        const serverTime: Timestamp = TimestampSchema.parse('2026-10-20T08:02:30Z');
        let calls = 0;
        const started = await setup({
            api: (fake) => ({
                register: (request, signal) => fake.api.register(request, signal),
                heartbeat(engineId, rawBody, signature, signal) {
                    calls++;
                    if (calls === 1) {
                        return Promise.resolve({
                            kind: 'refused',
                            status: 401,
                            problem: { code: 'stale-timestamp', serverTime },
                        });
                    }
                    if (calls === 2) return Promise.resolve({ kind: 'refused', status: 429, problem: null });
                    return fake.api.heartbeat(engineId, rawBody, signature, signal);
                },
            }),
        });
        started.loop.start();
        await until(() => started.loop.status().clockSkew !== null);
        expect(started.loop.status().clockSkew?.seconds).toBe(-150);
        started.clock.advance(60_000);
        await until(() => calls === 2);
        await flush(5);
        expect(started.loop.status().clockSkew?.seconds).toBe(-150);
        started.clock.advance(60_000);
        await received(started, 1);
        expect(started.fake.heartbeats[0]?.verification.kind).toBe('accepted');
        expect(started.loop.status().clockSkew).toBeNull();
        await started.loop.stop();
    });

    it('survives an unreachable dashboard and sends the next seq once it is back', async () => {
        const started = await setup();
        started.fake.unreachable = true;
        started.loop.start();
        await until(() => started.logger.entries.some((entry) => entry.event === 'heartbeat.unavailable'));
        expect(started.logger.entries).toContainEqual({ level: 'warn', event: 'heartbeat.unavailable', fields: {} });
        const attempted = started.loop.status().lastHeartbeat;
        if (attempted === null) throw new Error('nothing attempted');
        const attemptedSeq = seqOf(attempted.body);
        started.fake.unreachable = false;
        started.clock.advance(60_000);
        await received(started, 1);
        const next = started.fake.heartbeats[0];
        expect(next?.verification.kind).toBe('accepted');
        expect(seqOf(next?.rawBody ?? '')).toBeGreaterThan(attemptedSeq);
        await started.loop.stop();
    });

    it('logs a refusal with its status code only', async () => {
        const started = await setup();
        started.fake.suspend(started.identity.engineId);
        started.loop.start();
        await until(() => started.logger.entries.some((entry) => entry.event === 'heartbeat.refused'));
        expect(started.logger.entries.filter((entry) => entry.event === 'heartbeat.refused')).toEqual([
            { level: 'warn', event: 'heartbeat.refused', fields: { status: 403 } },
        ]);
        expect(started.loop.status().clockSkew).toBeNull();
        await started.loop.stop();
    });

    it('logs a failed beat and keeps ticking', async () => {
        let failures = 1;
        const started = await setup({
            seqs: (fallback) => ({
                next() {
                    if (failures > 0) {
                        failures--;
                        return Promise.reject(new Error('disk full'));
                    }
                    return fallback.next();
                },
            }),
        });
        started.loop.start();
        await until(() => started.logger.entries.some((entry) => entry.event === 'heartbeat.failed'));
        expect(started.logger.entries).toContainEqual({
            level: 'error',
            event: 'heartbeat.failed',
            fields: { problem: 'Error' },
        });
        expect(started.fake.heartbeats).toHaveLength(0);
        started.clock.advance(60_000);
        await received(started, 1);
        expect(started.fake.heartbeats[0]?.verification.kind).toBe('accepted');
        await started.loop.stop();
    });

    it('names a non-Error failure as unknown', async () => {
        const started = await setup({
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
            seqs: () => ({ next: () => Promise.reject('broken') }),
        });
        started.loop.start();
        await until(() => started.logger.entries.some((entry) => entry.event === 'heartbeat.failed'));
        expect(started.logger.entries).toContainEqual({
            level: 'error',
            event: 'heartbeat.failed',
            fields: { problem: 'unknown' },
        });
        await started.loop.stop();
    });

    it('skips a tick while the previous beat is still in flight, and stop aborts it', async () => {
        const release = deferred();
        let calls = 0;
        let aborted = false;
        const started = await setup({
            api: (fake) => ({
                register: (request, signal) => fake.api.register(request, signal),
                heartbeat(_engineId, _rawBody, _signature, signal) {
                    calls++;
                    return new Promise((resolve, reject) => {
                        signal.addEventListener('abort', () => {
                            aborted = true;
                            reject(new Error('aborted'));
                        });
                        void release.promise.then(() => {
                            resolve({ kind: 'accepted', status: 204, revocations: [] });
                        });
                    });
                },
            }),
        });
        started.loop.start();
        await until(() => calls === 1);
        started.clock.advance(60_000);
        await flush(5);
        expect(calls).toBe(1);
        expect(started.logger.entries).toContainEqual({ level: 'warn', event: 'heartbeat.skipped', fields: {} });
        await started.loop.stop();
        expect(aborted).toBe(true);
        expect(started.logger.entries.some((entry) => entry.event === 'heartbeat.failed')).toBe(false);
        started.clock.advance(600_000);
        await flush(10);
        expect(calls).toBe(1);
        expect(started.clock.pendingTimers()).toBe(0);
        release.resolve();
    });

    it('beats now on demand with the next seq, keeping the interval, and not before start or after stop', async () => {
        const started = await setup();
        started.loop.beatNow();
        await flush(5);
        expect(started.fake.heartbeats).toHaveLength(0);
        started.loop.start();
        await received(started, 1);
        started.clock.advance(10_000);
        started.loop.beatNow();
        await received(started, 2);
        started.clock.advance(50_000);
        await received(started, 3);
        const beats = started.fake.heartbeats;
        expect(beats.map((beat) => beat.verification.kind)).toEqual(['accepted', 'accepted', 'accepted']);
        const seqs = beats.map((beat) => seqOf(beat.rawBody));
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size).toBe(3);
        await started.loop.stop();
        started.loop.beatNow();
        await flush(10);
        expect(started.fake.heartbeats).toHaveLength(3);
    });

    it('reports setup in every beat, and beats at once when setup finishes', async () => {
        let setupState: SetupState = 'pending';
        const started = await setup({ setup: () => setupState });
        const setupOf = (index: number) => {
            const beat = started.fake.heartbeats[index];
            if (beat === undefined) throw new Error(`no beat ${String(index)}`);
            return Heartbeat.parse(JSON.parse(new TextDecoder().decode(beat.rawBody))).setup;
        };
        started.loop.start();
        await received(started, 1);
        expect(setupOf(0)).toBe('pending');
        started.clock.advance(SETUP_CHECK_MS * 5);
        await flush(5);
        expect(started.fake.heartbeats).toHaveLength(1);

        setupState = 'done';
        started.clock.advance(SETUP_CHECK_MS);
        await received(started, 2);
        expect(setupOf(1)).toBe('done');
        started.clock.advance(SETUP_CHECK_MS * 5);
        await flush(5);
        expect(started.fake.heartbeats).toHaveLength(2);
        await started.loop.stop();
    });

    it('carries ownerHandoff only while ready, and beats within a second of it turning ready', async () => {
        let ready = false;
        const started = await setup({ ownerHandoff: () => ready });
        const handoffOf = (index: number) => {
            const beat = started.fake.heartbeats[index];
            if (beat === undefined) throw new Error(`no beat ${String(index)}`);
            return Heartbeat.parse(JSON.parse(new TextDecoder().decode(beat.rawBody))).ownerHandoff;
        };
        started.loop.start();
        await received(started, 1);
        expect(handoffOf(0)).toBeUndefined();

        ready = true;
        started.clock.advance(SETUP_CHECK_MS);
        await received(started, 2);
        expect(handoffOf(1)).toBe('ready');
        started.clock.advance(SETUP_CHECK_MS * 5);
        await flush(5);
        expect(started.fake.heartbeats).toHaveLength(2);

        ready = false;
        started.clock.advance(DEFAULT_HEARTBEAT_INTERVAL_S * 1000);
        await received(started, 3);
        expect(handoffOf(2)).toBeUndefined();
        await started.loop.stop();
    });

    it('sends one more beat after a beat in flight when asked to beat now meanwhile', async () => {
        const release = deferred();
        let calls = 0;
        const started = await setup({
            api: (fake) => ({
                register: (request, signal) => fake.api.register(request, signal),
                async heartbeat(engineId, rawBody, signature, signal) {
                    calls++;
                    if (calls === 1) await release.promise;
                    return fake.api.heartbeat(engineId, rawBody, signature, signal);
                },
            }),
        });
        started.loop.start();
        await until(() => calls === 1);
        started.loop.beatNow();
        started.loop.beatNow();
        await flush(5);
        expect(calls).toBe(1);
        release.resolve();
        await received(started, 2);
        await flush(10);
        expect(calls).toBe(2);
        expect(started.fake.heartbeats.map((beat) => beat.verification.kind)).toEqual(['accepted', 'accepted']);
        await started.loop.stop();
    });

    it('can start again after stop', async () => {
        const started = await setup();
        started.loop.start();
        await received(started, 1);
        await started.loop.stop();
        started.clock.advance(120_000);
        await flush(10);
        expect(started.fake.heartbeats).toHaveLength(1);
        started.loop.start();
        await received(started, 2);
        expect(started.fake.heartbeats[1]?.verification.kind).toBe('accepted');
        await started.loop.stop();
    });

    it('never logs a signature or a body', async () => {
        const started = await setup({ clockOffsetMs: 300_000 });
        started.loop.start();
        await received(started, 1);
        started.fake.unreachable = true;
        started.clock.advance(60_000);
        await until(() => started.logger.entries.some((entry) => entry.event === 'heartbeat.unavailable'));
        const text = started.logger.text();
        for (const beat of started.fake.heartbeats) {
            expect(text).not.toContain((beat.signature ?? '').slice('ed25519='.length));
            expect(text).not.toContain(new TextDecoder().decode(beat.rawBody));
        }
        expect(text).not.toContain('"seq"');
        await started.loop.stop();
    });
});
