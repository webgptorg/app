import type { Timestamp } from '@ptbk/protocol';
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
import type { LastHeartbeat } from './heartbeat-loop';
import { DEFAULT_HEARTBEAT_INTERVAL_S, createHeartbeatLoop } from './heartbeat-loop';
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
    const sent: LastHeartbeat[] = [];
    const loop = createHeartbeatLoop({
        clock,
        logger,
        api: options.api?.(fake) ?? fake.api,
        seqs: options.seqs?.(memorySeqs) ?? memorySeqs,
        system: createScenarioSystemStats(() => 'small-team'),
        engine: { counts: () => ({ agents: 3, members: 2 }), updateState: () => 'none' },
        identity,
        version: VERSION,
        intervalS: options.intervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S,
        startedAtMs: START_MS,
        onSent: (heartbeat) => sent.push(heartbeat),
    });
    return { clock, logger, identity, fake, loop, sent, memorySeqs };
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

    it('keeps the exact last body for the security panel and reports it as sent', async () => {
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
        expect(status.lastHeartbeat?.sentAt).toBe(isoSeconds(started.clock.nowMs()));
        expect(Heartbeat.parse(JSON.parse(text)).ts).toBe(status.lastHeartbeat?.sentAt);
        expect(started.sent).toHaveLength(2);
        expect(started.sent.at(-1)).toEqual(status.lastHeartbeat);
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
                            resolve({ kind: 'accepted', status: 204 });
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
