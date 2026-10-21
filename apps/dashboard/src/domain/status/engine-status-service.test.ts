import { beforeEach, describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestEngine, type TestEngine } from '../../testing/test-engine';
import { signedHeartbeat } from '../../testing/test-heartbeat';
import { createStatusTestDeps, STATUS_START_MS as START } from '../../testing/test-status';
import type { OrgId } from '../ids';
import { ALERT_RETRY_DELAYS_MS, PAYLOAD_RETENTION_MS, type AlertRecipient } from './engine-status';
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
        const beat = async (seq: number, atMs = t.clock.nowMs()) => {
            const { body, signature } = await signedHeartbeat(engine, seq, atMs);
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
        return { ...t, service, beat, fireAlarm };
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
        expect(t.storage.alarmAt()).toBe(backAt + OFFLINE_AFTER_MS);

        await t.fireAlarm();
        expect(t.email.outbox.sent).toHaveLength(2);
        expect(t.email.outbox.sent[1]).toMatchObject({ lastSeenAt: backAt });
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
