import {
    ed25519PublicKeyToBytes,
    Timestamp,
    verifyHeartbeat,
    type AnyHeartbeat,
    type HeartbeatAttention,
    type HeartbeatVerification,
} from '@ptbk/protocol';

import type { ProjectStatusEvent } from '../../shared/notifications/kinds/project-status';
import { toBase64Url } from '../auth/secrets';
import type { Notifications } from '../notifications/notifications';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { EngineActivity } from '../usage/engine-activity';
import { heartbeatMilestones } from '../usage/engine-milestones';
import type { UsageRecorder } from '../usage/usage-recorder';
import type { RecordHeartbeatInput } from './engine-status-directory';
import type { EngineStatusStorage } from './engine-status-storage';
import type { HeartbeatEngineReader } from './heartbeat-engine-reader';
import {
    acceptHeartbeat,
    afterAlertAttempt,
    afterNoticeAttempt,
    lastSeqOf,
    nextAlarmAt,
    onAlarm,
    snapshotOf,
    type AlertAttempt,
    type EngineStatusSnapshot,
    type HeartbeatTiming,
    type OwedNotice,
    type StoredEngineStatus,
    type TrackedEngineStatus,
    withHeartbeatsSince,
} from './engine-status';

const SEND_TIMEOUT_MS = 10_000;

/** One spelling per set of counts: entries sorted, so the same counts in another order are no change. */
async function attentionDigest(entries: readonly HeartbeatAttention[]): Promise<string | undefined> {
    if (entries.length === 0) {
        return undefined;
    }
    const canonical = entries
        .map((entry) => [entry.to ?? '', entry.kind, entry.count] as const)
        .sort(([a, b], [c, d]) => (a === c ? (b < d ? -1 : 1) : a < c ? -1 : 1));
    const bytes = new TextEncoder().encode(JSON.stringify(canonical));
    return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export interface EngineStatusServiceDeps {
    readonly storage: EngineStatusStorage;
    /** The alarm's `now`; heartbeats are checked against the `receivedAt` the Worker passes. */
    readonly clock: Clock;
    readonly logger: Logger;
    readonly timing: HeartbeatTiming;
    /** Read before every send, so an engine revoked or suspended since its last heartbeat is told about to nobody. */
    readonly heartbeatEngines: HeartbeatEngineReader;
    /** Offline, online, back online, update waiting and the engine's counts reach people through the pipeline (D-41). */
    readonly notifications: Pick<Notifications, 'notify' | 'syncAttention'>;
    /** The first heartbeat and setup completion; written only on those, never per heartbeat. */
    readonly usage: UsageRecorder;
}

/**
 * What one engine's Durable Object does. Calls for one engine interleave only while the alarm sends email, so the alarm
 * reloads the status before storing what the send settled.
 */
export interface EngineStatusService {
    recordHeartbeat(input: RecordHeartbeatInput): Promise<HeartbeatVerification>;
    getStatus(): Promise<EngineStatusSnapshot>;
    /** The daily counters for the usage rollup (ADR 0022); null before the first counted heartbeat. */
    getActivity(): Promise<EngineActivity | null>;
    reset(): Promise<void>;
    alarm(): Promise<void>;
}

export function createEngineStatusService(deps: EngineStatusServiceDeps): EngineStatusService {
    /**
     * Hands the status change to the notification pipeline, which merges, delays and emails it (ADR 0027); nothing once
     * the engine is no longer active. A failure is retried on the outage's own schedule.
     */
    async function deliver(status: TrackedEngineStatus, event: ProjectStatusEvent): Promise<AlertAttempt> {
        try {
            const engine = await deps.heartbeatEngines.findEngine(status.engineId);
            if (engine?.status !== 'active') {
                return { kind: 'engine-inactive' };
            }
            await deps.notifications.notify(
                'project-status',
                { orgId: status.orgId, engineId: status.engineId },
                event,
                AbortSignal.timeout(SEND_TIMEOUT_MS),
            );
            return { kind: 'delivered' };
        } catch {
            return { kind: 'unresolved' };
        }
    }

    function noticeEvent(notice: OwedNotice): ProjectStatusEvent {
        switch (notice.kind) {
            case 'online':
                return { kind: 'online', at: notice.dueAt };
            case 'back-online':
                return { kind: 'back-online' };
        }
    }

    /**
     * Whether an update waits for someone now, told to the pipeline only when that changes. A failed call keeps the old
     * value, so the next heartbeat tries again; nothing is written to D1 while it stays the same (ADR 0022).
     */
    async function updateNotice(
        stored: StoredEngineStatus | null,
        status: TrackedEngineStatus,
    ): Promise<TrackedEngineStatus> {
        const waiting = status.payload.update === 'available';
        // Statuses stored before D-41 hold no `updateWaiting`, and were told nothing.
        const told = stored?.kind === 'tracked' && stored.updateWaiting === true;
        if (waiting === told) {
            return { ...status, updateWaiting: told };
        }
        try {
            await deps.notifications.notify(
                'update-waiting',
                { orgId: status.orgId, engineId: status.engineId },
                { kind: waiting ? 'waiting' : 'done' },
                AbortSignal.timeout(SEND_TIMEOUT_MS),
            );
            return { ...status, updateWaiting: waiting };
        } catch {
            deps.logger.warn('engine-status.update-notice-failed', { engineId: status.engineId });
            return { ...status, updateWaiting: told };
        }
    }

    /** Stores what an attempt settled, unless heartbeats accepted during the send moved the status on. */
    async function settle(next: { readonly status: TrackedEngineStatus; readonly alarmAt: number }): Promise<void> {
        const status = withHeartbeatsSince(next.status, await deps.storage.load());
        await deps.storage.save(status);
        await deps.storage.setAlarm(status === next.status ? next.alarmAt : nextAlarmAt(status, deps.timing));
    }

    /**
     * The engine's unseen counts, handed to the pipeline only when they differ from the last ones it took (ADR 0027),
     * so a steady inbox writes nothing to D1. Absent (the owner switched sharing off) reads like empty: the engine's
     * rows close and its notifications stay inside the engine. A failed hand-over keeps the old digest, so the next
     * heartbeat tries again.
     */
    async function attentionNotice(
        stored: StoredEngineStatus | null,
        status: TrackedEngineStatus,
        heartbeat: AnyHeartbeat,
    ): Promise<TrackedEngineStatus> {
        const entries = heartbeat.v === 2 ? (heartbeat.attention ?? []) : [];
        const digest = await attentionDigest(entries);
        const last = stored?.kind === 'tracked' ? stored.attentionDigest : undefined;
        // `status` is a fresh heartbeat's, which carries no digest of its own.
        const keep = (value: string | undefined) =>
            value === undefined ? status : { ...status, attentionDigest: value };
        if (digest === last) {
            return keep(last);
        }
        try {
            await deps.notifications.syncAttention(
                { orgId: status.orgId, engineId: status.engineId },
                entries,
                AbortSignal.timeout(SEND_TIMEOUT_MS),
            );
            return keep(digest);
        } catch {
            deps.logger.warn('engine-status.attention-failed', { engineId: status.engineId });
            return keep(last);
        }
    }

    return {
        async recordHeartbeat(input) {
            const stored = await deps.storage.load();
            const verification = await verifyHeartbeat({
                rawBody: input.rawBody,
                signatureHeader: input.signatureHeader,
                engineId: input.engineId,
                publicKey: ed25519PublicKeyToBytes(input.publicKey),
                lastSeq: lastSeqOf(stored),
                now: Timestamp.parse(new Date(input.receivedAt).toISOString()),
            });
            if (verification.kind === 'accepted') {
                const accepted = acceptHeartbeat({
                    stored,
                    orgId: input.orgId,
                    heartbeat: verification.heartbeat,
                    receivedAt: input.receivedAt,
                });
                const status = await attentionNotice(
                    stored,
                    await updateNotice(stored, accepted),
                    verification.heartbeat,
                );
                await deps.storage.save(status);
                // A notice now owed fires the alarm at once, so the heartbeat's answer never waits on email.
                await deps.storage.setAlarm(nextAlarmAt(status, deps.timing));
                // Once or twice in an engine's life; best effort, so a failed write costs only the event.
                await deps.usage.record(heartbeatMilestones(stored, status));
            }
            return verification;
        },

        async getStatus() {
            return snapshotOf(await deps.storage.load());
        },

        async getActivity() {
            const stored = await deps.storage.load();
            return stored?.kind === 'tracked' ? (stored.activity ?? null) : null;
        },

        async reset() {
            await deps.storage.deleteAll();
        },

        async alarm() {
            const now = deps.clock.nowMs();
            const step = onAlarm(await deps.storage.load(), now, deps.timing);
            switch (step.kind) {
                case 'idle':
                    return;
                case 'wait':
                    await deps.storage.setAlarm(step.at);
                    return;
                case 'purge':
                    await deps.storage.save(step.status);
                    deps.logger.info('engine-status.purged', { engineId: step.engineId });
                    return;
                case 'alert': {
                    const { engineId } = step.status;
                    if (step.status.alert.attempt === 0) {
                        deps.logger.info('engine-status.offline', { engineId });
                    }
                    // Stored first: if sending crashes the object, the retried alarm finds the outage already marked.
                    await deps.storage.save(step.status);
                    const { status } = step;
                    const attempt = await deliver(status, { kind: 'offline', lastSeenAt: status.lastSeenAt });
                    const next = afterAlertAttempt(step.status, attempt, now);
                    await settle(next);
                    if (attempt.kind === 'unresolved') {
                        deps.logger.warn('engine-status.alert-failed', {
                            engineId,
                            outcome: attempt.kind,
                            attempt: step.status.alert.attempt,
                            final: next.status.alert.kind === 'failed',
                        });
                    }
                    return;
                }
                case 'notice': {
                    const { notice } = step.status;
                    const { status } = step;
                    const attempt = await deliver(status, noticeEvent(notice));
                    const next = afterNoticeAttempt(step.status, attempt, now, deps.timing);
                    await settle(next);
                    if (attempt.kind === 'unresolved') {
                        deps.logger.warn('engine-status.notice-failed', {
                            engineId: step.status.engineId,
                            notice: notice.kind,
                            outcome: attempt.kind,
                            attempt: notice.attempt,
                            final: next.status.notice.kind === 'none',
                        });
                    }
                    return;
                }
            }
        },
    };
}
