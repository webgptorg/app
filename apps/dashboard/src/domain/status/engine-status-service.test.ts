import { beforeEach, describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestEngine, type TestEngine } from '../../testing/test-engine';
import { signedHeartbeat } from '../../testing/test-heartbeat';
import { createStatusTestDeps, STATUS_START_MS as START } from '../../testing/test-status';
import type { OrgId } from '../ids';
import type { EngineStatus } from '../registration/engine-store';
import {
    ALERT_RETRY_DELAYS_MS,
    PAYLOAD_RETENTION_MS,
    storedEngineStatusSchema,
    type AlertRecipient,
} from './engine-status';
import { createEngineStatusService } from './engine-status-service';

const OFFLINE_AFTER_MS = (3 * 60 + 15) * 1000;
const OWNER: AlertRecipient = { email: 'owner@example.test', locale: 'cs' };
const CO_OWNER: AlertRecipient = { email: 'co-owner@example.test', locale: 'en' };

describe('engine status service', () => {
    let engine: TestEngine;
    let orgId: OrgId;

    beforeEach(async () => {
        engine = await createTestEngine();
        orgId = testOrgId();
    });

    function setup(options: Parameters<typeof createStatusTestDeps>[0] = {}) {
        const t = createStatusTestDeps({ recipients: new Map([[orgId, [OWNER]]]), ...options });
        const service = createEngineStatusService(t.deps);
        const beat = async (seq: number, atMs = t.clock.nowMs(), overrides: { members?: number } = {}) => {
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
        const sentOf = (template: string) => t.email.outbox.sent.filter((message) => message.template === template);
        return { ...t, service, beat, newEngineBeat, sentOf, fireAlarm };
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

    it('goes offline after 3 missed intervals plus grace, and emails the owner once in their locale', async () => {
        const t = setup();
        await t.beat(1);
        t.clock.set(START + OFFLINE_AFTER_MS - 1);
        await t.service.alarm();
        expect((await t.service.getStatus()).state).toBe('online');
        expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);
        expect(t.email.outbox.sent).toEqual([]);

        await t.fireAlarm();
        expect(await t.service.getStatus()).toMatchObject({
            state: 'offline',
            lastSeenAt: START,
            offlineSince: START + OFFLINE_AFTER_MS,
        });
        expect(t.email.outbox.sent).toEqual([
            {
                template: 'engine-offline',
                to: OWNER.email,
                locale: 'cs',
                engineId: engine.engineId,
                hostname: `${engine.engineId}.engines.ptbk.test`,
                lastSeenAt: START,
                link: `https://app.ptbk.test/engines/${engine.engineId}`,
            },
        ]);
        expect(t.logger.entries).toContainEqual({
            level: 'info',
            event: 'engine-status.offline',
            fields: { engineId: engine.engineId },
        });

        // The next alarm is the retention purge; nothing before it sends again.
        expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
        t.clock.advance(24 * 3600_000);
        await t.service.alarm();
        expect(t.email.outbox.sent).toHaveLength(1);
        expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
    });

    it('comes back online on a heartbeat after an outage, and alerts again on the next one', async () => {
        const t = setup();
        await t.beat(1);
        await t.fireAlarm();
        expect(t.email.outbox.sent).toHaveLength(1);

        t.clock.advance(10 * 60_000);
        const backAt = t.clock.nowMs();
        expect((await t.beat(2)).kind).toBe('accepted');
        const status = await t.service.getStatus();
        expect(status).toMatchObject({ state: 'online', lastSeenAt: backAt });
        expect(status).not.toHaveProperty('offlineSince');

        await t.fireAlarm();
        expect(t.storage.alarmAt()).toBe(backAt + OFFLINE_AFTER_MS);
        await t.fireAlarm();
        expect(t.sentOf('engine-offline')).toHaveLength(2);
        expect(t.sentOf('engine-offline')[1]).toMatchObject({ lastSeenAt: backAt });
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
        expect(t.email.outbox.sent).toHaveLength(1);

        // A purged engine is watched again from its next heartbeat; its timestamp keeps old bodies out.
        await t.service.alarm();
        expect(t.storage.alarmAt()).toBeNull();
        expect((await t.beat(5)).kind).toBe('accepted');
        expect(await t.service.getStatus()).toMatchObject({ state: 'online', lastSeq: 5 });
    });

    it('retries a failed send with backoff, owing the email only to whom it failed for', async () => {
        const t = setup({ recipients: new Map([[orgId, [OWNER, CO_OWNER]]]) });
        t.email.failing.add(OWNER.email);
        await t.beat(1);
        await t.fireAlarm();
        const offlineAt = START + OFFLINE_AFTER_MS;
        expect(t.email.outbox.sent.map((message) => message.to)).toEqual([CO_OWNER.email]);
        expect(t.storage.alarmAt()).toBe(offlineAt + ALERT_RETRY_DELAYS_MS[0]);
        expect(t.logger.entries).toContainEqual({
            level: 'warn',
            event: 'engine-status.alert-failed',
            fields: { engineId: engine.engineId, outcome: 'partly-failed', attempt: 0, final: false },
        });

        await t.fireAlarm();
        expect(t.email.attempts.map((message) => message.to)).toEqual([OWNER.email, CO_OWNER.email, OWNER.email]);
        expect(t.storage.alarmAt()).toBe(t.clock.nowMs() + ALERT_RETRY_DELAYS_MS[1]);

        t.email.failing.clear();
        await t.fireAlarm();
        expect(t.email.outbox.sent.map((message) => message.to)).toEqual([CO_OWNER.email, OWNER.email]);
        expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
        expect(t.logger.entries.filter((entry) => entry.event === 'engine-status.offline')).toHaveLength(1);
    });

    it('gives up after three retries and sends nothing more for the outage', async () => {
        const t = setup();
        t.email.failing.add(OWNER.email);
        await t.beat(1);
        for (let attempt = 0; attempt <= ALERT_RETRY_DELAYS_MS.length; attempt++) {
            await t.fireAlarm();
        }
        expect(t.email.attempts).toHaveLength(ALERT_RETRY_DELAYS_MS.length + 1);
        expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
        expect(t.logger.entries.at(-1)).toEqual({
            level: 'warn',
            event: 'engine-status.alert-failed',
            fields: { engineId: engine.engineId, outcome: 'partly-failed', attempt: 3, final: true },
        });
        t.email.failing.clear();
        t.clock.advance(60_000);
        await t.service.alarm();
        expect(t.email.outbox.sent).toEqual([]);
    });

    it('resolves the recipients again on retry when they could not be read', async () => {
        let unavailable = true;
        const t = setup({ recipientsFail: () => unavailable });
        await t.beat(1);
        await t.fireAlarm();
        expect(t.email.attempts).toEqual([]);
        expect(t.logger.entries.at(-1)).toMatchObject({ fields: { outcome: 'unresolved', attempt: 0 } });
        unavailable = false;
        await t.fireAlarm();
        expect(t.email.outbox.sent.map((message) => message.to)).toEqual([OWNER.email]);
    });

    it('settles an outage with nobody to tell without sending anything', async () => {
        const t = setup({ recipients: new Map() });
        await t.beat(1);
        await t.fireAlarm();
        expect(t.email.attempts).toEqual([]);
        expect((await t.service.getStatus()).state).toBe('offline');
        expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
    });

    describe('first online', () => {
        it('emails the owner once when a new engine sends its first heartbeat, from the alarm', async () => {
            const t = setup();
            expect((await t.newEngineBeat(1)).kind).toBe('accepted');
            expect(t.email.attempts).toEqual([]);
            expect(t.storage.alarmAt()).toBe(START);

            await t.fireAlarm();
            expect(t.email.outbox.sent).toEqual([
                {
                    template: 'engine-online',
                    to: OWNER.email,
                    locale: 'cs',
                    engineId: engine.engineId,
                    hostname: `${engine.engineId}.engines.ptbk.test`,
                    link: `https://app.ptbk.test/engines/${engine.engineId}`,
                },
            ]);
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);

            t.clock.advance(60_000);
            await t.newEngineBeat(2);
            expect(t.storage.alarmAt()).toBe(START + 60_000 + OFFLINE_AFTER_MS);
            await t.fireAlarm();
            t.clock.advance(60 * 60_000);
            await t.newEngineBeat(3);
            await t.fireAlarm();
            expect(t.email.outbox.sent.map((message) => message.template)).toEqual([
                'engine-online',
                'engine-offline',
                'engine-back-online',
            ]);
        });

        it('sends none when the first heartbeat already counts a member, nor when a later one counts none', async () => {
            const t = setup();
            await t.beat(1);
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);
            t.clock.advance(60_000);
            await t.newEngineBeat(2);
            expect(t.storage.alarmAt()).toBe(START + 60_000 + OFFLINE_AFTER_MS);
            expect(t.email.attempts).toEqual([]);
        });

        it('retries a failed send with the alert backoff, which later heartbeats do not postpone', async () => {
            const t = setup({ recipients: new Map([[orgId, [OWNER, CO_OWNER]]]) });
            t.email.failing.add(OWNER.email);
            await t.newEngineBeat(1);
            await t.fireAlarm();
            expect(t.storage.alarmAt()).toBe(START + ALERT_RETRY_DELAYS_MS[0]);
            expect(t.logger.entries).toContainEqual({
                level: 'warn',
                event: 'engine-status.notice-failed',
                fields: {
                    engineId: engine.engineId,
                    notice: 'online',
                    outcome: 'partly-failed',
                    attempt: 0,
                    final: false,
                },
            });

            t.clock.advance(30_000);
            await t.newEngineBeat(2);
            expect(t.storage.alarmAt()).toBe(START + ALERT_RETRY_DELAYS_MS[0]);
            await t.service.alarm();
            expect(t.storage.alarmAt()).toBe(START + ALERT_RETRY_DELAYS_MS[0]);
            expect(t.email.attempts).toHaveLength(2);
            t.email.failing.clear();
            await t.fireAlarm();
            expect(t.email.attempts.map((message) => message.to)).toEqual([OWNER.email, CO_OWNER.email, OWNER.email]);
            expect(t.sentOf('engine-online').map((message) => message.to)).toEqual([CO_OWNER.email, OWNER.email]);
            expect(t.storage.alarmAt()).toBe(START + 30_000 + OFFLINE_AFTER_MS);
        });

        it('resolves the recipients again on retry, and gives up after three retries', async () => {
            let unavailable = true;
            const t = setup({ recipientsFail: () => unavailable });
            await t.newEngineBeat(1);
            await t.fireAlarm();
            expect(t.logger.entries.at(-1)).toMatchObject({ fields: { outcome: 'unresolved', attempt: 0 } });
            unavailable = false;
            t.email.failing.add(OWNER.email);
            for (let seq = 2; seq <= ALERT_RETRY_DELAYS_MS.length + 1; seq++) {
                const stored = t.storage.stored();
                if (stored?.kind !== 'tracked' || stored.notice.kind === 'none') {
                    throw new Error('no notice owed');
                }
                // A heartbeat right at each retry keeps the engine online through the longer delays.
                t.clock.set(stored.notice.dueAt);
                await t.newEngineBeat(seq);
                await t.fireAlarm();
            }
            expect(t.email.attempts).toHaveLength(ALERT_RETRY_DELAYS_MS.length);
            expect(t.logger.entries.at(-1)).toMatchObject({ fields: { attempt: 3, final: true } });
            expect(t.storage.stored()).toMatchObject({ notice: { kind: 'none' } });
            expect(t.storage.alarmAt()).toBe(t.clock.nowMs() + OFFLINE_AFTER_MS);
        });

        it('drops a notice still owed when the engine goes offline, and alerts that instead', async () => {
            const t = setup();
            t.email.failing.add(OWNER.email);
            await t.newEngineBeat(1);
            await t.fireAlarm();
            await t.fireAlarm();
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);
            t.email.failing.clear();
            await t.fireAlarm();
            expect(t.email.outbox.sent.map((message) => message.template)).toEqual(['engine-offline']);
            expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
        });
    });

    describe('back online', () => {
        it('emails once on the first heartbeat after an outage that sent an offline email', async () => {
            const t = setup();
            await t.beat(1);
            await t.fireAlarm();
            expect(t.sentOf('engine-offline')).toHaveLength(1);

            t.clock.advance(2 * 3600_000);
            const backAt = t.clock.nowMs();
            await t.beat(2);
            expect(t.storage.alarmAt()).toBe(backAt);
            await t.fireAlarm();
            expect(t.sentOf('engine-back-online')).toEqual([
                {
                    template: 'engine-back-online',
                    to: OWNER.email,
                    locale: 'cs',
                    engineId: engine.engineId,
                    hostname: `${engine.engineId}.engines.ptbk.test`,
                    lastSeenAt: START,
                    backOnlineAt: backAt,
                    link: `https://app.ptbk.test/engines/${engine.engineId}`,
                },
            ]);
            expect(t.storage.alarmAt()).toBe(backAt + OFFLINE_AFTER_MS);

            t.clock.advance(60_000);
            await t.beat(3);
            await t.fireAlarm();
            expect(t.sentOf('engine-back-online')).toHaveLength(1);
            expect(t.sentOf('engine-online')).toEqual([]);
        });

        it('sends none after a gap shorter than the offline threshold', async () => {
            const t = setup();
            await t.beat(1);
            t.clock.advance(OFFLINE_AFTER_MS - 1);
            await t.service.alarm();
            await t.beat(2);
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS - 1 + OFFLINE_AFTER_MS);
            await t.service.alarm();
            expect(t.email.attempts).toEqual([]);
        });

        it('sends none when the outage never got its offline email out', async () => {
            const t = setup();
            t.email.failing.add(OWNER.email);
            await t.beat(1);
            await t.fireAlarm();
            t.email.failing.clear();
            t.clock.advance(30_000);
            await t.beat(2);
            expect(t.storage.alarmAt()).toBe(t.clock.nowMs() + OFFLINE_AFTER_MS);
            expect(t.email.outbox.sent).toEqual([]);
        });

        it('emails when an engine returns after the retention purge, from the time it was last seen', async () => {
            const t = setup();
            await t.beat(1);
            await t.fireAlarm();
            await t.fireAlarm();
            expect(t.storage.stored()).toMatchObject({ kind: 'purged' });
            t.clock.advance(3600_000);
            await t.beat(2);
            await t.fireAlarm();
            expect(t.sentOf('engine-back-online')).toEqual([
                expect.objectContaining({ lastSeenAt: START, backOnlineAt: START + PAYLOAD_RETENTION_MS + 3600_000 }),
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
        ] as const)('sends no offline alert once %s, and still purges it', async (_, status) => {
            const t = setupEngine();
            await t.beat(1);
            t.setStatus(status);
            await t.fireAlarm();
            expect(t.email.attempts).toEqual([]);
            expect(await t.service.getStatus()).toMatchObject({ state: 'offline', lastSeq: 1 });
            expect(t.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
            expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
            await t.fireAlarm();
            expect(await t.service.getStatus()).toMatchObject({ state: 'offline', lastSeq: null });
            expect(t.storage.alarmAt()).toBeNull();
        });

        it('stops retrying a failed alert once revoked', async () => {
            const t = setupEngine();
            t.email.failing.add(OWNER.email);
            await t.beat(1);
            await t.fireAlarm();
            expect(t.email.attempts).toHaveLength(1);
            t.setStatus('suspended');
            t.email.failing.clear();
            await t.fireAlarm();
            expect(t.email.attempts).toHaveLength(1);
            expect(t.storage.alarmAt()).toBe(START + PAYLOAD_RETENTION_MS);
        });

        it('drops the online notice it owes once revoked, and keeps watching the engine', async () => {
            const t = setupEngine();
            await t.newEngineBeat(1);
            t.setStatus('suspended');
            await t.fireAlarm();
            expect(t.email.attempts).toEqual([]);
            expect(t.storage.alarmAt()).toBe(START + OFFLINE_AFTER_MS);
            await t.fireAlarm();
            expect(t.email.attempts).toEqual([]);
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
            expect(t.email.attempts).toEqual([]);
        });

        it('retries when it cannot read whether the engine is still active', async () => {
            const t = setupEngine();
            await t.beat(1);
            t.setUnreadable(true);
            await t.fireAlarm();
            expect(t.email.attempts).toEqual([]);
            expect(t.logger.entries.at(-1)).toMatchObject({ fields: { outcome: 'unresolved', attempt: 0 } });
            t.setUnreadable(false);
            await t.fireAlarm();
            expect(t.email.outbox.sent.map((message) => message.to)).toEqual([OWNER.email]);
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
    });

    describe('a heartbeat accepted while the alarm is sending', () => {
        /**
         * The object takes other calls while it awaits D1 or the email binding: the alarm's sends run `during` first,
         * on the same storage, then deliver.
         */
        function alarmSendingDuring(t: ReturnType<typeof setup>, during: () => Promise<unknown>) {
            let ran = false;
            const sending = createEngineStatusService({
                ...t.deps,
                email: {
                    async send(message, signal) {
                        if (!ran) {
                            ran = true;
                            await during();
                        }
                        await t.email.send(message, signal);
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

        it('is kept by a notice, which still goes out once', async () => {
            const t = setup();
            await t.newEngineBeat(1);
            t.clock.advance(1000);
            const fire = alarmSendingDuring(t, () => t.beat(2));
            await fire();
            expect(await t.service.getStatus()).toMatchObject({ lastSeq: 2, lastSeenAt: START + 1000 });
            expect(await t.beat(2)).toEqual({ kind: 'replayed-seq' });
            expect(t.storage.alarmAt()).toBe(START + 1000 + OFFLINE_AFTER_MS);
            expect(t.sentOf('engine-online')).toHaveLength(1);
        });

        it('ends the outage the offline email announces, and owes the back-online email', async () => {
            const t = setup();
            await t.beat(1);
            const backAt = START + OFFLINE_AFTER_MS + 1000;
            const fire = alarmSendingDuring(t, async () => {
                t.clock.set(backAt);
                await t.beat(2);
            });
            await fire();
            expect(t.sentOf('engine-offline')).toHaveLength(1);
            expect(await t.service.getStatus()).toMatchObject({ state: 'online', lastSeq: 2, lastSeenAt: backAt });
            expect(await t.beat(2)).toEqual({ kind: 'replayed-seq' });
            expect(t.storage.alarmAt()).toBe(backAt);
            await t.fireAlarm();
            expect(t.sentOf('engine-back-online')).toEqual([
                expect.objectContaining({ lastSeenAt: START, backOnlineAt: backAt }),
            ]);
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
