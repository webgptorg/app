import type { HeartbeatInput } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestEngine, type TestEngine } from '../../testing/test-engine';
import { signedHeartbeat } from '../../testing/test-heartbeat';
import { createStatusTestDeps, STATUS_START_MS as START } from '../../testing/test-status';
import type { OrgId } from '../ids';
import type { EngineStatus } from '../registration/engine-store';
import { ALERT_RETRY_DELAYS_MS, PAYLOAD_RETENTION_MS, storedEngineStatusSchema } from './engine-status';
import { createEngineStatusService } from './engine-status-service';
import { createTestUsage } from '../../testing/test-usage';

const OFFLINE_AFTER_MS = (3 * 60 + 15) * 1000;

describe('engine status service', () => {
    let engine: TestEngine;
    let orgId: OrgId;

    beforeEach(async () => {
        engine = await createTestEngine();
        orgId = testOrgId();
    });

    function setup(options: Parameters<typeof createStatusTestDeps>[0] = {}) {
        const t = createStatusTestDeps(options);
        const service = createEngineStatusService(t.deps);
        const beat = async (
            seq: number,
            atMs = t.clock.nowMs(),
            overrides: Partial<Pick<HeartbeatInput, 'members' | 'setup' | 'agents' | 'ownerHandoff' | 'update'>> = {},
        ) => {
            const { body, signature } = await signedHeartbeat(engine, seq, atMs, overrides);
            return service.recordHeartbeat({
                engineId: engine.engineId,
                orgId,
                publicKey: engine.publicKey,
                rawBody: body,
                signatureHeader: signature,
                receivedAt: t.clock.nowMs(),
            });
        };
        /** What the runtime does at the alarm's time: moves the clock there, clears it and runs the handler. */
        const fireAlarm = async () => {
            const at = t.storage.takeAlarm();
            if (at === null) {
                throw new Error('no alarm set');
            }
            t.clock.set(Math.max(at, t.clock.nowMs()));
            await service.alarm();
        };
        /** A heartbeat of an engine nobody has set up yet (M-08: `members` counts members with a passkey). */
        const newEngineBeat = (seq: number) => beat(seq, t.clock.nowMs(), { members: 0 });
        /** The project-status events handed to the notification pipeline, by their kind. */
        const statusEvents = (kind?: 'online' | 'offline' | 'back-online') =>
            t.notifications.calls
                .filter((call) => call.kind === 'project-status')
                .map((call) => call.event as { readonly kind: string })
                .filter((event) => kind === undefined || event.kind === kind);
        return { ...t, service, beat, newEngineBeat, statusEvents, fireAlarm };
    }

    it('accepts a heartbeat, stores its numbers and arms the offline alarm', async () => {
        const t = setup();
        expect(await t.service.getStatus()).toEqual({ state: 'never-seen' });
        expect((await t.beat(1)).kind).toBe('accepted');
        expect(await t.service.getStatus()).toEqual({
            state: 'online',
            lastSeenAt: START,
            lastSeq: 1,
            payload: {
                ts: new Date(START).toISOString(),
                receivedAt: START,
                version: '1.4.2',
                uptimeS: 3600,
                diskPct: 40,
                ramPct: 70,
                cpuLoad: 'low',
                update: 'none',
                agents: 3,
                members: 2,
            },
        });
        expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);
        t.clock.advance(60_000);
        expect((await t.beat(2)).kind).toBe('accepted');
        expect(t.storage.alarmAt()).toBe(START + 60_000 + OFFLINE_AFTER_MS);
    });

    it('stores the setup state each heartbeat reports, and none when a heartbeat leaves it out', async () => {
        const t = setup();
        const setupOf = async () => {
            const status = await t.service.getStatus();
            return status.state === 'never-seen' ? undefined : status.payload;
        };
        await t.beat(1, t.clock.nowMs(), { setup: 'pending' });
        expect(await setupOf()).toMatchObject({ setup: 'pending' });
        t.clock.advance(60_000);
        await t.beat(2, t.clock.nowMs(), { setup: 'done' });
        expect(await setupOf()).toMatchObject({ setup: 'done' });
        t.clock.advance(60_000);
        await t.beat(3);
        expect(await setupOf()).not.toHaveProperty('setup');
    });

    it('keeps the latest heartbeat’s owner handoff signal only, so one without it clears it (ADR 0023)', async () => {
        const t = setup();
        const payloadOf = async () => {
            const status = await t.service.getStatus();
            return status.state === 'never-seen' ? undefined : status.payload;
        };
        await t.beat(1, t.clock.nowMs(), { members: 0 });
        expect(await payloadOf()).not.toHaveProperty('ownerHandoff');
        t.clock.advance(5_000);
        await t.beat(2, t.clock.nowMs(), { members: 0, ownerHandoff: 'ready' });
        expect(await payloadOf()).toMatchObject({ members: 0, ownerHandoff: 'ready' });
        t.clock.advance(60_000);
        await t.beat(3, t.clock.nowMs(), { members: 1 });
        expect(await payloadOf()).not.toHaveProperty('ownerHandoff');
    });

    it('refuses an equal and a lower seq as replayed, through verifyHeartbeat with the stored lastSeq', async () => {
        const t = setup();
        await t.beat(10);
        t.clock.advance(1000);
        expect(await t.beat(10)).toEqual({ kind: 'replayed-seq' });
        expect(await t.beat(9)).toEqual({ kind: 'replayed-seq' });
        expect(await t.service.getStatus()).toMatchObject({ lastSeq: 10, lastSeenAt: START });
    });

    it('stores nothing and arms nothing for a refused heartbeat', async () => {
        const t = setup();
        expect(await t.beat(1, START - 121_000)).toEqual({
            kind: 'stale-ts',
            serverTime: new Date(START).toISOString(),
        });
        expect(await t.service.getStatus()).toEqual({ state: 'never-seen' });
        expect(t.storage.alarmAt()).toBeNull();
    });

    it('goes offline after 3 missed intervals plus grace, and tells the pipeline once, with the target', async () => {
        const t = setup();
        await t.beat(1);
        t.clock.set(START + OFFLINE_AFTER_MS - 1);
        await t.service.alarm();
        expect((await t.service.getStatus()).state).toBe('online');
        expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);
        expect(t.notifications.calls).toEqual([]);

        await t.fireAlarm();
        expect(await t.service.getStatus()).toMatchObject({
            state: 'offline',
            lastSeenAt: START,
            offlineSince: START + OFFLINE_AFTER_MS,
        });
        expect(t.notifications.calls).toEqual([
            {
                kind: 'project-status',
                orgId,
                engineId: engine.engineId,
                event: { kind: 'offline', lastSeenAt: START },
            },
        ]);
        expect(t.logger.entries).toContainEqual({
            level: 'info',
            event: 'engine-status.offline',
            fields: { engineId: engine.engineId },
        });

        // The next alarm is the retention purge; nothing before it is told again.
        expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
        t.clock.advance(24 * 3600_000);
        await t.service.alarm();
        expect(t.notifications.calls).toHaveLength(1);
        expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
    });

    it('comes back online on a heartbeat after an outage, and alerts again on the next one', async () => {
        const t = setup();
        await t.beat(1);
        await t.fireAlarm();
        expect(t.statusEvents('offline')).toHaveLength(1);

        t.clock.advance(10 * 60_000);
        const backAt = t.clock.nowMs();
        expect((await t.beat(2)).kind).toBe('accepted');
        const status = await t.service.getStatus();
        expect(status).toMatchObject({ state: 'online', lastSeenAt: backAt });
        expect(status).not.toHaveProperty('offlineSince');

        await t.fireAlarm();
        expect(t.storage.alarmAt()).toBe(backAt + OFFLINE_AFTER_MS);
        await t.fireAlarm();
        expect(t.statusEvents('offline')).toEqual([
            { kind: 'offline', lastSeenAt: START },
            { kind: 'offline', lastSeenAt: backAt },
        ]);
    });

    it('purges the payload thirty days after the last heartbeat, keeping only the state and when it was seen', async () => {
        const t = setup();
        await t.beat(1_800_000_000_000);
        await t.fireAlarm();
        await t.fireAlarm();
        expect(t.clock.nowMs()).toBe(START + PAYLOAD_RETENTION_MS);
        expect(t.storage.stored()).toEqual({ kind: 'purged', state: 'offline', lastSeenAt: START });
        expect(await t.service.getStatus()).toEqual({
            state: 'offline',
            lastSeenAt: START,
            lastSeq: null,
            payload: null,
        });
        expect(t.storage.alarmAt()).toBeNull();
        expect(t.logger.entries).toContainEqual({
            level: 'info',
            event: 'engine-status.purged',
            fields: { engineId: engine.engineId },
        });
        expect(t.notifications.calls).toHaveLength(1);

        // A purged engine is watched again from its next heartbeat; its timestamp keeps old bodies out.
        await t.service.alarm();
        expect(t.storage.alarmAt()).toBeNull();
        expect((await t.beat(5)).kind).toBe('accepted');
        expect(await t.service.getStatus()).toMatchObject({ state: 'online', lastSeq: 5 });
    });

    it('retries with backoff while the pipeline cannot take the outage, and gives up after three retries', async () => {
        const t = setup();
        t.notifications.failing = true;
        await t.beat(1);
        await t.fireAlarm();
        const offlineAt = START + OFFLINE_AFTER_MS;
        expect(t.storage.alarmAt()).toBe(offlineAt + ALERT_RETRY_DELAYS_MS[0]);
        expect(t.logger.entries).toContainEqual({
            level: 'warn',
            event: 'engine-status.alert-failed',
            fields: { engineId: engine.engineId, outcome: 'unresolved', attempt: 0, final: false },
        });
        for (let attempt = 1; attempt <= ALERT_RETRY_DELAYS_MS.length; attempt++) {
            await t.fireAlarm();
        }
        expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
        expect(t.logger.entries.at(-1)).toEqual({
            level: 'warn',
            event: 'engine-status.alert-failed',
            fields: { engineId: engine.engineId, outcome: 'unresolved', attempt: 3, final: true },
        });
        t.notifications.failing = false;
        t.clock.advance(60_000);
        await t.service.alarm();
        expect(t.notifications.calls).toEqual([]);
        expect(t.logger.entries.filter((entry) => entry.event === 'engine-status.offline')).toHaveLength(1);
    });

    it('hands the outage over on a retry once the pipeline takes it', async () => {
        const t = setup();
        t.notifications.failing = true;
        await t.beat(1);
        await t.fireAlarm();
        t.notifications.failing = false;
        await t.fireAlarm();
        expect(t.statusEvents('offline')).toHaveLength(1);
        expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
    });

    describe('first online', () => {
        it('tells the pipeline once when a new engine sends its first heartbeat, from the alarm', async () => {
            const t = setup();
            expect((await t.newEngineBeat(1)).kind).toBe('accepted');
            expect(t.notifications.calls).toEqual([]);
            expect(t.storage.alarmAt()).toBe(START);

            await t.fireAlarm();
            expect(t.statusEvents()).toEqual([{ kind: 'online', at: START }]);
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);

            t.clock.advance(60_000);
            await t.newEngineBeat(2);
            expect(t.storage.alarmAt()).toBe(START + 60_000 + OFFLINE_AFTER_MS);
            await t.fireAlarm();
            t.clock.advance(60 * 60_000);
            await t.newEngineBeat(3);
            await t.fireAlarm();
            expect(t.statusEvents().map((event) => event.kind)).toEqual(['online', 'offline', 'back-online']);
        });

        it('owes none when the first heartbeat already counts a member, nor when a later one counts none', async () => {
            const t = setup();
            await t.beat(1);
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);
            t.clock.advance(60_000);
            await t.newEngineBeat(2);
            expect(t.storage.alarmAt()).toBe(START + 60_000 + OFFLINE_AFTER_MS);
            expect(t.notifications.calls).toEqual([]);
        });

        it('retries with the alert backoff, which later heartbeats do not postpone, and gives up after three', async () => {
            const t = setup();
            t.notifications.failing = true;
            await t.newEngineBeat(1);
            await t.fireAlarm();
            expect(t.storage.alarmAt()).toBe(START + ALERT_RETRY_DELAYS_MS[0]);
            expect(t.logger.entries).toContainEqual({
                level: 'warn',
                event: 'engine-status.notice-failed',
                fields: {
                    engineId: engine.engineId,
                    notice: 'online',
                    outcome: 'unresolved',
                    attempt: 0,
                    final: false,
                },
            });
            t.clock.advance(30_000);
            await t.newEngineBeat(2);
            expect(t.storage.alarmAt()).toBe(START + ALERT_RETRY_DELAYS_MS[0]);
            for (let seq = 3; seq <= ALERT_RETRY_DELAYS_MS.length + 2; seq++) {
                const stored = t.storage.stored();
                if (stored?.kind !== 'tracked' || stored.notice.kind === 'none') {
                    throw new Error('no notice owed');
                }
                // A heartbeat right at each retry keeps the engine online through the longer delays.
                t.clock.set(stored.notice.dueAt);
                await t.newEngineBeat(seq);
                await t.fireAlarm();
            }
            expect(t.logger.entries.at(-1)).toMatchObject({ fields: { attempt: 3, final: true } });
            expect(t.storage.stored()).toMatchObject({ notice: { kind: 'none' } });
            expect(t.storage.alarmAt()).toBe(t.clock.nowMs() + OFFLINE_AFTER_MS);
        });

        it('drops a notice still owed when the engine goes offline, and hands that over instead', async () => {
            const t = setup();
            t.notifications.failing = true;
            await t.newEngineBeat(1);
            await t.fireAlarm();
            await t.fireAlarm();
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);
            t.notifications.failing = false;
            await t.fireAlarm();
            expect(t.statusEvents().map((event) => event.kind)).toEqual(['offline']);
            expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
        });
    });

    describe('back online', () => {
        it('tells the pipeline once on the first heartbeat after an outage it was told of', async () => {
            const t = setup();
            await t.beat(1);
            await t.fireAlarm();
            t.clock.advance(2 * 3600_000);
            const backAt = t.clock.nowMs();
            await t.beat(2);
            expect(t.storage.alarmAt()).toBe(backAt);
            await t.fireAlarm();
            expect(t.statusEvents('back-online')).toEqual([{ kind: 'back-online' }]);
            expect(t.storage.alarmAt()).toBe(backAt + OFFLINE_AFTER_MS);

            t.clock.advance(60_000);
            await t.beat(3);
            await t.fireAlarm();
            expect(t.statusEvents('back-online')).toHaveLength(1);
            expect(t.statusEvents('online')).toEqual([]);
        });

        it('owes none after a gap shorter than the offline threshold', async () => {
            const t = setup();
            await t.beat(1);
            t.clock.advance(OFFLINE_AFTER_MS - 1);
            await t.service.alarm();
            await t.beat(2);
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS - 1 + OFFLINE_AFTER_MS);
            await t.service.alarm();
            expect(t.notifications.calls).toEqual([]);
        });

        it('owes none when the outage was never handed over', async () => {
            const t = setup();
            t.notifications.failing = true;
            await t.beat(1);
            await t.fireAlarm();
            t.notifications.failing = false;
            t.clock.advance(30_000);
            await t.beat(2);
            expect(t.storage.alarmAt()).toBe(t.clock.nowMs() + OFFLINE_AFTER_MS);
            expect(t.notifications.calls).toEqual([]);
        });

        it('tells it when an engine returns after the retention purge', async () => {
            const t = setup();
            await t.beat(1);
            await t.fireAlarm();
            await t.fireAlarm();
            expect(t.storage.stored()).toMatchObject({ kind: 'purged' });
            t.clock.advance(3600_000);
            await t.beat(2);
            await t.fireAlarm();
            expect(t.statusEvents('back-online')).toHaveLength(1);
        });
    });

    describe('update waiting', () => {
        it('tells the pipeline when an update starts and stops waiting, and nothing while it stays the same', async () => {
            const t = setup();
            await t.beat(1);
            t.clock.advance(60_000);
            await t.beat(2, t.clock.nowMs(), { update: 'available' });
            t.clock.advance(60_000);
            await t.beat(3, t.clock.nowMs(), { update: 'available' });
            t.clock.advance(60_000);
            await t.beat(4, t.clock.nowMs(), { update: 'installing' });
            t.clock.advance(60_000);
            await t.beat(5);
            expect(t.notifications.calls.filter((call) => call.kind === 'update-waiting')).toEqual([
                { kind: 'update-waiting', orgId, engineId: engine.engineId, event: { kind: 'waiting' } },
                { kind: 'update-waiting', orgId, engineId: engine.engineId, event: { kind: 'done' } },
            ]);
        });

        it('accepts the heartbeat when the pipeline fails, and tries again on the next one', async () => {
            const t = setup();
            t.notifications.failing = true;
            expect((await t.beat(1, t.clock.nowMs(), { update: 'available' })).kind).toBe('accepted');
            expect(t.logger.entries).toContainEqual({
                level: 'warn',
                event: 'engine-status.update-notice-failed',
                fields: { engineId: engine.engineId },
            });
            t.notifications.failing = false;
            t.clock.advance(60_000);
            await t.beat(2, t.clock.nowMs(), { update: 'available' });
            expect(t.notifications.calls).toEqual([
                { kind: 'update-waiting', orgId, engineId: engine.engineId, event: { kind: 'waiting' } },
            ]);
        });
    });

    describe('an engine no longer active', () => {
        function setupEngine() {
            let status: EngineStatus | null = 'active';
            let unreadable = false;
            const t = setup({
                engineStatus: () =>
                    unreadable ? Promise.reject(new Error('database unavailable')) : Promise.resolve(status),
            });
            return {
                ...t,
                setStatus: (next: EngineStatus | null) => (status = next),
                setUnreadable: (next: boolean) => (unreadable = next),
            };
        }

        it.each([
            ['revoked or suspended', 'suspended'],
            ['removed', null],
        ] as const)('hands over no outage once %s, and still purges it', async (_, status) => {
            const t = setupEngine();
            await t.beat(1);
            t.setStatus(status);
            await t.fireAlarm();
            expect(t.notifications.calls).toEqual([]);
            expect(await t.service.getStatus()).toMatchObject({ state: 'offline', lastSeq: 1 });
            expect(t.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
            expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
            await t.fireAlarm();
            expect(await t.service.getStatus()).toMatchObject({ state: 'offline', lastSeq: null });
            expect(t.storage.alarmAt()).toBeNull();
        });

        it('stops retrying once revoked', async () => {
            const t = setupEngine();
            t.notifications.failing = true;
            await t.beat(1);
            await t.fireAlarm();
            t.setStatus('suspended');
            t.notifications.failing = false;
            await t.fireAlarm();
            expect(t.notifications.calls).toEqual([]);
            expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
        });

        it('drops the online notice it owes once revoked, and keeps watching the engine', async () => {
            const t = setupEngine();
            await t.newEngineBeat(1);
            t.setStatus('suspended');
            await t.fireAlarm();
            expect(t.notifications.calls).toEqual([]);
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);
            await t.fireAlarm();
            expect(t.notifications.calls).toEqual([]);
        });

        it('owes no back-online notice when a suspension is lifted after an outage it kept quiet', async () => {
            const t = setupEngine();
            await t.beat(1);
            t.setStatus('suspended');
            await t.fireAlarm();
            t.setStatus('active');
            t.clock.advance(60 * 60_000);
            await t.beat(2);
            expect(t.storage.alarmAt()).toBe(t.clock.nowMs() + OFFLINE_AFTER_MS);
            expect(t.notifications.calls).toEqual([]);
        });

        it('retries when it cannot read whether the engine is still active', async () => {
            const t = setupEngine();
            await t.beat(1);
            t.setUnreadable(true);
            await t.fireAlarm();
            expect(t.notifications.calls).toEqual([]);
            expect(t.logger.entries.at(-1)).toMatchObject({ fields: { outcome: 'unresolved', attempt: 0 } });
            t.setUnreadable(false);
            await t.fireAlarm();
            expect(t.statusEvents('offline')).toHaveLength(1);
        });
    });

    it('reads a status stored before notices existed as owing none', () => {
        const legacy = {
            kind: 'tracked',
            engineId: engine.engineId,
            orgId,
            state: 'online',
            lastSeenAt: START,
            lastSeq: 1,
            payload: {
                ts: new Date(START).toISOString(),
                receivedAt: START,
                version: '1.4.2',
                uptimeS: 1,
                diskPct: 1,
                ramPct: 1,
                cpuLoad: 'low',
                update: 'none',
                agents: 0,
                members: 0,
            },
            offlineSince: null,
            alert: { kind: 'none' },
        };
        expect(storedEngineStatusSchema.parse(legacy)).toMatchObject({ notice: { kind: 'none' } });
        // Nor did it know setup states: its payload parses without one, which reads as set up.
        expect(storedEngineStatusSchema.parse(legacy)).not.toHaveProperty('payload.setup');
    });

    describe('a heartbeat accepted while the alarm is handing over', () => {
        /** The object takes other calls while it awaits D1: the alarm's hand-over runs `during` first, then itself. */
        function alarmNotifyingDuring(t: ReturnType<typeof setup>, during: () => Promise<unknown>) {
            let ran = false;
            const sending = createEngineStatusService({
                ...t.deps,
                notifications: {
                    async notify(kind, target, event, signal) {
                        if (!ran) {
                            ran = true;
                            await during();
                        }
                        await t.notifications.notify(kind, target, event, signal);
                    },
                },
            });
            return async () => {
                const at = t.storage.takeAlarm();
                if (at === null) {
                    throw new Error('no alarm set');
                }
                t.clock.set(Math.max(at, t.clock.nowMs()));
                await sending.alarm();
            };
        }

        it('is kept by a notice, which is still handed over once', async () => {
            const t = setup();
            await t.newEngineBeat(1);
            t.clock.advance(1000);
            const fire = alarmNotifyingDuring(t, () => t.beat(2));
            await fire();
            expect(await t.service.getStatus()).toMatchObject({ lastSeq: 2, lastSeenAt: START + 1000 });
            expect(await t.beat(2)).toEqual({ kind: 'replayed-seq' });
            expect(t.storage.alarmAt()).toBe(START + 1000 + OFFLINE_AFTER_MS);
            expect(t.statusEvents('online')).toHaveLength(1);
        });

        it('ends the outage it hands over, and owes back online', async () => {
            const t = setup();
            await t.beat(1);
            const backAt = START + OFFLINE_AFTER_MS + 1000;
            const fire = alarmNotifyingDuring(t, async () => {
                t.clock.set(backAt);
                await t.beat(2);
            });
            await fire();
            expect(t.statusEvents('offline')).toHaveLength(1);
            expect(await t.service.getStatus()).toMatchObject({ state: 'online', lastSeq: 2, lastSeenAt: backAt });
            expect(await t.beat(2)).toEqual({ kind: 'replayed-seq' });
            expect(t.storage.alarmAt()).toBe(backAt);
            await t.fireAlarm();
            expect(t.statusEvents('back-online')).toHaveLength(1);
        });
    });

    describe('usage data (ADR 0022)', () => {
        it('records the first heartbeat and the setup completion once each, and nothing for the beats between', async () => {
            const t = setup();
            for (const [seq, state] of [
                [1, 'pending'],
                [2, 'pending'],
                [3, 'done'],
                [4, 'done'],
            ] as const) {
                t.clock.advance(60_000);
                expect((await t.beat(seq, t.clock.nowMs(), { setup: state })).kind).toBe('accepted');
            }
            expect(t.usage.state.events.map((row) => [row.event, row.orgId, row.engineId, row.props])).toEqual([
                ['engine.first_heartbeat', orgId, engine.engineId, '{"setup":"pending"}'],
                ['engine.setup_completed', orgId, engine.engineId, '{}'],
            ]);
        });

        it('counts each UTC day’s heartbeats in the status it saves, keeping the day before', async () => {
            const t = setup();
            expect(await t.service.getActivity()).toBeNull();
            await t.beat(1);
            t.clock.advance(60_000);
            await t.beat(2, t.clock.nowMs(), { setup: 'pending', agents: 5 });
            const midnight = Date.UTC(2027, 0, 16);
            t.clock.set(midnight + 30_000);
            await t.beat(3);
            const last = { engineVersion: '1.4.2', members: 2, updateState: 'none', cpuLoad: 'low' };
            expect(await t.service.getActivity()).toEqual({
                current: {
                    day: '2027-01-16',
                    beats: 1,
                    firstBeatAt: midnight + 30_000,
                    lastBeatAt: midnight + 30_000,
                    agents: 3,
                    setup: null,
                    ...last,
                },
                previous: {
                    day: '2027-01-15',
                    beats: 2,
                    firstBeatAt: START,
                    lastBeatAt: START + 60_000,
                    agents: 5,
                    setup: 'pending',
                    ...last,
                },
            });
        });

        it('answers no activity for a status saved before it was counted', async () => {
            const t = setup();
            await t.beat(1);
            const stored = t.storage.stored();
            if (stored?.kind !== 'tracked') {
                throw new Error('expected a tracked status');
            }
            await t.storage.save({ ...stored, activity: undefined });
            expect(await t.service.getActivity()).toBeNull();
        });

        it('answers no activity for a purged engine', async () => {
            const t = setup();
            await t.beat(1);
            await t.fireAlarm();
            await t.fireAlarm();
            expect(t.storage.stored()).toMatchObject({ kind: 'purged' });
            expect(await t.service.getActivity()).toBeNull();
        });

        it('accepts the heartbeat when the event cannot be written', async () => {
            const t = setup();
            const service = createEngineStatusService({
                ...t.deps,
                usage: createTestUsage({
                    store: { insertEvents: () => Promise.reject(new Error('D1 unavailable')) },
                    logger: t.logger,
                }).recorder,
            });
            const { body, signature } = await signedHeartbeat(engine, 1, t.clock.nowMs());
            const outcome = await service.recordHeartbeat({
                engineId: engine.engineId,
                orgId,
                publicKey: engine.publicKey,
                rawBody: body,
                signatureHeader: signature,
                receivedAt: t.clock.nowMs(),
            });
            expect(outcome.kind).toBe('accepted');
            expect(t.logger.entries).toContainEqual({
                level: 'warn',
                event: 'usage.record-failed',
                fields: { error: 'Error', events: 1 },
            });
        });
    });

    it('does nothing on an alarm for an engine it has never seen', async () => {
        const t = setup();
        await t.service.alarm();
        expect(t.storage.alarmAt()).toBeNull();
        expect(await t.service.getStatus()).toEqual({ state: 'never-seen' });
    });

    it('forgets everything on reset', async () => {
        const t = setup();
        await t.beat(1);
        await t.service.reset();
        expect(await t.service.getStatus()).toEqual({ state: 'never-seen' });
        expect(t.storage.alarmAt()).toBeNull();
        expect((await t.beat(1)).kind).toBe('accepted');
    });
});
