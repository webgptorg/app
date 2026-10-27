import {
    ed25519PublicKeyToBytes,
    Timestamp,
    verifyHeartbeat,
    type EngineId,
    type HeartbeatVerification,
} from '@ptbk/protocol';

import type { Clock } from '../ports/clock';
import type { EmailMessage, EmailSender } from '../ports/email-sender';
import type { Logger } from '../ports/logger';
import type { AlertRecipients } from './alert-recipients';
import type { RecordHeartbeatInput } from './engine-status-directory';
import type { EngineStatusStorage } from './engine-status-storage';
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
} from './engine-status';

const SEND_TIMEOUT_MS = 10_000;

export interface EngineStatusServiceDeps {
    readonly storage: EngineStatusStorage;
    /** The alarm's `now`; heartbeats are checked against the `receivedAt` the Worker passes. */
    readonly clock: Clock;
    readonly logger: Logger;
    readonly timing: HeartbeatTiming;
    readonly recipients: AlertRecipients;
    readonly email: EmailSender;
    readonly engineHostname: (engineId: EngineId) => string;
    /** The engine's page in the dashboard. */
    readonly engineLink: (engineId: EngineId) => string;
}

/** What one engine's Durable Object does; every call for one engine runs alone, so `seq` checks cannot race. */
export interface EngineStatusService {
    recordHeartbeat(input: RecordHeartbeatInput): Promise<HeartbeatVerification>;
    getStatus(): Promise<EngineStatusSnapshot>;
    reset(): Promise<void>;
    alarm(): Promise<void>;
}

export function createEngineStatusService(deps: EngineStatusServiceDeps): EngineStatusService {
    /** One email to each recipient: the ones owed from a failed attempt, or else everyone the organization alerts. */
    async function deliver(
        status: TrackedEngineStatus,
        owed: readonly AlertRecipient[] | null,
        compose: (recipient: AlertRecipient) => EmailMessage,
    ): Promise<AlertAttempt> {
        let recipients: readonly AlertRecipient[];
        try {
            recipients =
                owed ?? (await deps.recipients.forEngineStatus(status.orgId, AbortSignal.timeout(SEND_TIMEOUT_MS)));
        } catch {
            return { kind: 'unresolved' };
        }
        const failed: AlertRecipient[] = [];
        for (const recipient of recipients) {
            try {
                await deps.email.send(compose(recipient), AbortSignal.timeout(SEND_TIMEOUT_MS));
            } catch {
                failed.push(recipient);
            }
        }
        return failed.length === 0 ? { kind: 'delivered' } : { kind: 'partly-failed', failed };
    }

    function engineFields(status: TrackedEngineStatus, recipient: AlertRecipient) {
        return {
            to: recipient.email,
            locale: recipient.locale,
            engineId: status.engineId,
            hostname: deps.engineHostname(status.engineId),
            link: deps.engineLink(status.engineId),
        };
    }

    function noticeMessage(
        status: TrackedEngineStatus & { readonly notice: OwedNotice },
        recipient: AlertRecipient,
    ): EmailMessage {
        const { notice } = status;
        switch (notice.kind) {
            case 'online':
                return { template: 'engine-online', ...engineFields(status, recipient) };
            case 'back-online':
                return {
                    template: 'engine-back-online',
                    ...engineFields(status, recipient),
                    lastSeenAt: notice.lastSeenAt,
                    backOnlineAt: notice.backOnlineAt,
                };
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
                    const attempt = await deliver(status, status.alert.recipients, (recipient) => ({
                        template: 'engine-offline',
                        ...engineFields(status, recipient),
                        lastSeenAt: status.lastSeenAt,
                    }));
                    const next = afterAlertAttempt(step.status, attempt, now);
                    await deps.storage.save(next.status);
                    await deps.storage.setAlarm(next.alarmAt);
                    if (attempt.kind !== 'delivered') {
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
                    const attempt = await deliver(status, notice.recipients, (recipient) =>
                        noticeMessage(status, recipient),
                    );
                    const next = afterNoticeAttempt(step.status, attempt, now, deps.timing);
                    await deps.storage.save(next.status);
                    await deps.storage.setAlarm(next.alarmAt);
                    if (attempt.kind !== 'delivered') {
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
