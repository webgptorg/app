import { CpuLoad, EngineId, EngineVersion, Timestamp, UpdateState, type Heartbeat } from '@ptbk/protocol';
import { z } from 'zod';

import { orgIdSchema } from '../ids';
import { localeSchema } from '../locale';

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

/** Spec retention: thirty days after the last heartbeat only the state and the time it was last seen remain. */
export const PAYLOAD_RETENTION_MS = 30 * DAY_MS;

/** Delays before each retry of a failed status email; its length is how many retries there are. */
export const ALERT_RETRY_DELAYS_MS = [60 * SECOND_MS, 5 * 60 * SECOND_MS, 15 * 60 * SECOND_MS] as const;

export interface HeartbeatTiming {
    readonly intervalS: number;
    readonly missedLimit: number;
    readonly graceS: number;
    /** Heartbeats per engine and minute; counted by the route, before the engine's object is touched. */
    readonly perEngineLimit: number;
}

/** How long after the last accepted heartbeat an engine counts as offline. */
export function offlineAfterMs(timing: HeartbeatTiming): number {
    return (timing.missedLimit * timing.intervalS + timing.graceS) * SECOND_MS;
}

const count = z.int().min(0);

/** What we keep of an accepted heartbeat: C-03's numbers and closed enums, and when it was sent and received. */
export const heartbeatPayloadSchema = z.strictObject({
    ts: Timestamp,
    receivedAt: count,
    version: EngineVersion,
    uptimeS: count,
    diskPct: count,
    ramPct: count,
    cpuLoad: CpuLoad,
    update: UpdateState,
    agents: count,
    members: count,
});
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;

export const alertRecipientSchema = z.strictObject({ email: z.string().max(254), locale: localeSchema });
export type AlertRecipient = z.infer<typeof alertRecipientSchema>;

/**
 * The offline alert of the current outage. `pending` keeps whom a failed attempt still owes the email (`null`: the
 * recipients could not be resolved), so a retry never mails anyone twice. `none` arms the next outage.
 */
const delivery = {
    attempt: z.int().min(0).max(ALERT_RETRY_DELAYS_MS.length),
    recipients: z.array(alertRecipientSchema).max(1000).nullable(),
};

const outageAlertSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('pending'), ...delivery }),
    z.strictObject({ kind: z.literal('sent') }),
    z.strictObject({ kind: z.literal('failed') }),
]);
export type OutageAlert = z.infer<typeof outageAlertSchema>;

/**
 * The good news still owed, sent from the alarm at `dueAt` with the offline alert's recipients and retries: `online`
 * once per engine, `back-online` once per outage whose offline email went out. A new outage drops it as stale.
 */
const noticeSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('online'), dueAt: count, ...delivery }),
    z.strictObject({
        kind: z.literal('back-online'),
        dueAt: count,
        /** The last heartbeat before the outage. */
        lastSeenAt: count,
        backOnlineAt: count,
        ...delivery,
    }),
]);
export type StatusNotice = z.infer<typeof noticeSchema>;
export type OwedNotice = Exclude<StatusNotice, { readonly kind: 'none' }>;

const trackedSchema = z.strictObject({
    kind: z.literal('tracked'),
    engineId: EngineId,
    orgId: orgIdSchema,
    state: z.enum(['online', 'offline']),
    lastSeenAt: count,
    lastSeq: count,
    payload: heartbeatPayloadSchema,
    offlineSince: count.nullable(),
    alert: outageAlertSchema,
    // Statuses stored before D-12 have no notice and owe none.
    notice: noticeSchema.default({ kind: 'none' }),
});

/** After the retention purge: nothing about the engine but that it is offline and when it was last seen. */
const purgedSchema = z.strictObject({ kind: z.literal('purged'), state: z.literal('offline'), lastSeenAt: count });

/** One engine's status as its Durable Object stores it; parsed on every read, so storage cannot hand us a stray field. */
export const storedEngineStatusSchema = z.discriminatedUnion('kind', [trackedSchema, purgedSchema]);
export type StoredEngineStatus = z.infer<typeof storedEngineStatusSchema>;
export type TrackedEngineStatus = z.infer<typeof trackedSchema>;

/** What the dashboard may show about an engine. `lastSeq` and `payload` are null only after the retention purge. */
export type EngineStatusSnapshot =
    | { readonly state: 'never-seen' }
    | {
          readonly state: 'online' | 'offline';
          readonly lastSeenAt: number;
          readonly lastSeq: number | null;
          readonly payload: HeartbeatPayload | null;
          readonly offlineSince?: number;
      };

export function snapshotOf(stored: StoredEngineStatus | null): EngineStatusSnapshot {
    if (stored === null) {
        return { state: 'never-seen' };
    }
    switch (stored.kind) {
        case 'purged':
            return { state: 'offline', lastSeenAt: stored.lastSeenAt, lastSeq: null, payload: null };
        case 'tracked':
            return {
                state: stored.state,
                lastSeenAt: stored.lastSeenAt,
                lastSeq: stored.lastSeq,
                payload: stored.payload,
                ...(stored.offlineSince === null ? {} : { offlineSince: stored.offlineSince }),
            };
    }
}

export function lastSeqOf(stored: StoredEngineStatus | null): number | null {
    return stored?.kind === 'tracked' ? stored.lastSeq : null;
}

/**
 * What an accepted heartbeat owes. An engine that counts a member on its very first heartbeat had an owner before it
 * was linked, who needs no reminder to finish setup. A purged engine was offline for thirty days, so its outage was
 * alerted, even though the purge kept no record of it.
 */
function noticeAfter(stored: StoredEngineStatus | null, members: number, receivedAt: number): StatusNotice {
    const owed = { dueAt: receivedAt, attempt: 0, recipients: null };
    if (stored === null) {
        return members === 0 ? { kind: 'online', ...owed } : { kind: 'none' };
    }
    const alerted = stored.kind === 'purged' || (stored.state === 'offline' && stored.alert.kind === 'sent');
    if (alerted) {
        return { kind: 'back-online', lastSeenAt: stored.lastSeenAt, backOnlineAt: receivedAt, ...owed };
    }
    return stored.notice;
}

/**
 * An accepted heartbeat: online, and whatever outage came before is over, so the next one alerts again. A notice still
 * owed stays owed, on its own schedule.
 */
export function acceptHeartbeat(input: {
    readonly stored: StoredEngineStatus | null;
    readonly orgId: TrackedEngineStatus['orgId'];
    readonly heartbeat: Heartbeat;
    readonly receivedAt: number;
}): TrackedEngineStatus {
    const { heartbeat } = input;
    return {
        kind: 'tracked',
        engineId: heartbeat.engineId,
        orgId: input.orgId,
        state: 'online',
        lastSeenAt: input.receivedAt,
        lastSeq: heartbeat.seq,
        payload: {
            ts: heartbeat.ts,
            receivedAt: input.receivedAt,
            version: heartbeat.version,
            uptimeS: heartbeat.uptimeS,
            diskPct: heartbeat.diskPct,
            ramPct: heartbeat.ramPct,
            cpuLoad: heartbeat.cpuLoad,
            update: heartbeat.update,
            agents: heartbeat.agents,
            members: heartbeat.members,
        },
        offlineSince: null,
        alert: { kind: 'none' },
        notice: noticeAfter(input.stored, heartbeat.members, input.receivedAt),
    };
}

/**
 * What the alarm stores after a send when heartbeats were accepted meanwhile: the object takes other calls while it
 * awaits D1 or the email binding, so `current` may be newer than the status the attempt settled. The heartbeats win,
 * owing the notice they would have owed had they come after the attempt; overwriting them would roll `lastSeq` back.
 */
export function withHeartbeatsSince(
    settled: TrackedEngineStatus,
    current: StoredEngineStatus | null,
): TrackedEngineStatus {
    if (current?.kind !== 'tracked' || current.lastSeq <= settled.lastSeq) {
        return settled;
    }
    return { ...current, notice: noticeAfter(settled, current.payload.members, current.lastSeenAt) };
}

/** When a settled status's alarm fires next: the notice it owes, or else going offline or the retention purge. */
export function nextAlarmAt(status: TrackedEngineStatus, timing: HeartbeatTiming): number {
    const watchAt =
        status.state === 'online'
            ? status.lastSeenAt + offlineAfterMs(timing)
            : status.lastSeenAt + PAYLOAD_RETENTION_MS;
    return status.notice.kind === 'none' ? watchAt : Math.min(watchAt, status.notice.dueAt);
}

export type AlarmStep =
    /** Nothing to watch: never seen, or already purged. */
    | { readonly kind: 'idle' }
    /** Too early (the alarm fired before its time, or the outage alert is settled): come back at `at`. */
    | { readonly kind: 'wait'; readonly at: number }
    /** Store `status` (offline, alert pending), then send the alert it owes. */
    | {
          readonly kind: 'alert';
          readonly status: TrackedEngineStatus & { readonly alert: { readonly kind: 'pending' } };
      }
    /** Send the notice `status` owes; nothing is stored before, since a notice is already stored when it is owed. */
    | { readonly kind: 'notice'; readonly status: TrackedEngineStatus & { readonly notice: OwedNotice } }
    | { readonly kind: 'purge'; readonly engineId: EngineId; readonly status: StoredEngineStatus };

/** What the engine's alarm does at `now`. */
export function onAlarm(stored: StoredEngineStatus | null, now: number, timing: HeartbeatTiming): AlarmStep {
    if (stored === null || stored.kind === 'purged') {
        return { kind: 'idle' };
    }
    const alert = stored.alert;
    if (alert.kind === 'pending') {
        return { kind: 'alert', status: { ...stored, alert } };
    }
    if (stored.state === 'online' && now >= stored.lastSeenAt + offlineAfterMs(timing)) {
        return {
            kind: 'alert',
            status: {
                ...stored,
                state: 'offline',
                offlineSince: now,
                alert: { kind: 'pending', attempt: 0, recipients: null },
                notice: { kind: 'none' },
            },
        };
    }
    const notice = stored.notice;
    if (notice.kind !== 'none' && now >= notice.dueAt) {
        return { kind: 'notice', status: { ...stored, notice } };
    }
    if (stored.state === 'online' || now < stored.lastSeenAt + PAYLOAD_RETENTION_MS) {
        return { kind: 'wait', at: nextAlarmAt(stored, timing) };
    }
    return {
        kind: 'purge',
        engineId: stored.engineId,
        status: { kind: 'purged', state: 'offline', lastSeenAt: stored.lastSeenAt },
    };
}

export type AlertAttempt =
    | { readonly kind: 'delivered' }
    /** Some sends failed; these recipients are still owed the email. */
    | { readonly kind: 'partly-failed'; readonly failed: readonly AlertRecipient[] }
    /** The recipients could not be resolved; nobody was sent anything. */
    | { readonly kind: 'unresolved' };

/** Where a notice attempt leaves the status: settled once delivered or out of retries, else owed again later. */
export function afterNoticeAttempt(
    status: TrackedEngineStatus & { readonly notice: OwedNotice },
    attempt: AlertAttempt,
    now: number,
    timing: HeartbeatTiming,
): { readonly status: TrackedEngineStatus; readonly alarmAt: number } {
    const delay = ALERT_RETRY_DELAYS_MS[status.notice.attempt];
    const notice: StatusNotice =
        attempt.kind === 'delivered' || delay === undefined
            ? { kind: 'none' }
            : {
                  ...status.notice,
                  dueAt: now + delay,
                  attempt: status.notice.attempt + 1,
                  recipients: attempt.kind === 'unresolved' ? null : [...attempt.failed],
              };
    const settled = { ...status, notice };
    return { status: settled, alarmAt: nextAlarmAt(settled, timing) };
}

/** Where an alert attempt leaves the outage, and when the alarm fires next (a retry, or the retention purge). */
export function afterAlertAttempt(
    status: TrackedEngineStatus & { readonly alert: { readonly kind: 'pending'; readonly attempt: number } },
    attempt: AlertAttempt,
    now: number,
): { readonly status: TrackedEngineStatus; readonly alarmAt: number } {
    const purgeAt = status.lastSeenAt + PAYLOAD_RETENTION_MS;
    if (attempt.kind === 'delivered') {
        return { status: { ...status, alert: { kind: 'sent' } }, alarmAt: purgeAt };
    }
    const delay = ALERT_RETRY_DELAYS_MS[status.alert.attempt];
    if (delay === undefined) {
        return { status: { ...status, alert: { kind: 'failed' } }, alarmAt: purgeAt };
    }
    return {
        status: {
            ...status,
            alert: {
                kind: 'pending',
                attempt: status.alert.attempt + 1,
                recipients: attempt.kind === 'unresolved' ? null : [...attempt.failed],
            },
        },
        alarmAt: now + delay,
    };
}
