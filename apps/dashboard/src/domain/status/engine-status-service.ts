import {
    ed25519PublicKeyToBytes,
    Timestamp,
    verifyHeartbeat,
    type EngineId,
    type HeartbeatVerification,
} from '@ptbk/protocol';

import { engineLabel } from '../../shared/engine-label';
import type { Clock } from '../ports/clock';
import type { EmailMessage, EmailSender } from '../ports/email-sender';
import type { Logger } from '../ports/logger';
import type { AlertRecipients } from './alert-recipients';
import type { RecordHeartbeatInput } from './engine-status-directory';
import type { EngineStatusStorage } from './engine-status-storage';
import type { HeartbeatEngine, HeartbeatEngineReader } from './heartbeat-engine-reader';
import {
    acceptHeartbeat,
    afterAlertAttempt,
    afterNoticeAttempt,
    lastSeqOf,
    nextAlarmAt,
    onAlarm,
    snapshotOf,
    type AlertAttempt,
    type AlertRecipient,
    type EngineStatusSnapshot,
    type HeartbeatTiming,
    type OwedNotice,
    type TrackedEngineStatus,
    withHeartbeatsSince,
} from './engine-status';

const SEND_TIMEOUT_MS = 10_000;

export interface EngineStatusServiceDeps {
    readonly storage: EngineStatusStorage;
    /** The alarm's `now`; heartbeats are checked against the `receivedAt` the Worker passes. */
    readonly clock: Clock;
    readonly logger: Logger;
    readonly timing: HeartbeatTiming;
    /** Read before every send, so an engine revoked or suspended since its last heartbeat is told about to nobody. */
    readonly heartbeatEngines: HeartbeatEngineReader;
    readonly recipients: AlertRecipients;
    readonly email: EmailSender;
    readonly engineHostname: (engineId: EngineId) => string;
    /** The engine's page in the dashboard. */
    readonly engineLink: (engineId: EngineId) => string;
}

/**
 * What one engine's Durable Object does. Calls for one engine interleave only while the alarm sends email, so the alarm
 * reloads the status before storing what the send settled.
 */
export interface EngineStatusService {
    recordHeartbeat(input: RecordHeartbeatInput): Promise<HeartbeatVerification>;
    getStatus(): Promise<EngineStatusSnapshot>;
    reset(): Promise<void>;
    alarm(): Promise<void>;
}

export function createEngineStatusService(deps: EngineStatusServiceDeps): EngineStatusService {
    /**
     * One email to each recipient, the ones owed from a failed attempt or else everyone the organization alerts; none
     * once the engine is no longer active.
     */
    async function deliver(
        status: TrackedEngineStatus,
        owed: readonly AlertRecipient[] | null,
        compose: (recipient: AlertRecipient, engine: HeartbeatEngine) => EmailMessage,
    ): Promise<AlertAttempt> {
        let recipients: readonly AlertRecipient[];
        let engine: HeartbeatEngine | null;
        try {
            engine = await deps.heartbeatEngines.findEngine(status.engineId);
            if (engine?.status !== 'active') {
                return { kind: 'engine-inactive' };
            }
            recipients =
                owed ??
                (await deps.recipients.forEngineStatus(
                    status.orgId,
                    status.engineId,
                    AbortSignal.timeout(SEND_TIMEOUT_MS),
                ));
        } catch {
            return { kind: 'unresolved' };
        }
        const failed: AlertRecipient[] = [];
        for (const recipient of recipients) {
            try {
                await deps.email.send(compose(recipient, engine), AbortSignal.timeout(SEND_TIMEOUT_MS));
            } catch {
                failed.push(recipient);
            }
        }
        return failed.length === 0 ? { kind: 'delivered' } : { kind: 'partly-failed', failed };
    }

    function engineFields(status: TrackedEngineStatus, recipient: AlertRecipient, engine: HeartbeatEngine) {
        return {
            to: recipient.email,
            locale: recipient.locale,
            label: engineLabel({ engineId: status.engineId, label: engine.label }),
            engineId: status.engineId,
            hostname: deps.engineHostname(status.engineId),
            link: deps.engineLink(status.engineId),
        };
    }

    function noticeMessage(
        status: TrackedEngineStatus & { readonly notice: OwedNotice },
        recipient: AlertRecipient,
        engine: HeartbeatEngine,
    ): EmailMessage {
        const { notice } = status;
        switch (notice.kind) {
            case 'online':
                return { template: 'engine-online', ...engineFields(status, recipient, engine) };
            case 'back-online':
                return {
                    template: 'engine-back-online',
                    ...engineFields(status, recipient, engine),
                    lastSeenAt: notice.lastSeenAt,
                    backOnlineAt: notice.backOnlineAt,
                };
        }
    }

    /** Stores what an attempt settled, unless heartbeats accepted during the send moved the status on. */
    async function settle(next: { readonly status: TrackedEngineStatus; readonly alarmAt: number }): Promise<void> {
        const status = withHeartbeatsSince(next.status, await deps.storage.load());
        await deps.storage.save(status);
        await deps.storage.setAlarm(status === next.status ? next.alarmAt : nextAlarmAt(status, deps.timing));
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
                const status = acceptHeartbeat({
                    stored,
                    orgId: input.orgId,
                    heartbeat: verification.heartbeat,
                    receivedAt: input.receivedAt,
                });
                await deps.storage.save(status);
                // A notice now owed fires the alarm at once, so the heartbeat's answer never waits on email.
                await deps.storage.setAlarm(nextAlarmAt(status, deps.timing));
            }
            return verification;
        },

        async getStatus() {
            return snapshotOf(await deps.storage.load());
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
                    const attempt = await deliver(status, status.alert.recipients, (recipient, engine) => ({
                        template: 'engine-offline',
                        ...engineFields(status, recipient, engine),
                        lastSeenAt: status.lastSeenAt,
                    }));
                    const next = afterAlertAttempt(step.status, attempt, now);
                    await settle(next);
                    if (attempt.kind === 'partly-failed' || attempt.kind === 'unresolved') {
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
                    const attempt = await deliver(status, notice.recipients, (recipient, engine) =>
                        noticeMessage(status, recipient, engine),
                    );
                    const next = afterNoticeAttempt(step.status, attempt, now, deps.timing);
                    await settle(next);
                    if (attempt.kind === 'partly-failed' || attempt.kind === 'unresolved') {
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
