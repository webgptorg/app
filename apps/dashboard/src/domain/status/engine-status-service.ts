import {
    ed25519PublicKeyToBytes,
    Timestamp,
    verifyHeartbeat,
    type EngineId,
    type HeartbeatVerification,
} from '@ptbk/protocol';

import type { Clock } from '../ports/clock';
import type { EmailSender } from '../ports/email-sender';
import type { Logger } from '../ports/logger';
import type { AlertRecipients } from './alert-recipients';
import type { RecordHeartbeatInput } from './engine-status-directory';
import type { EngineStatusStorage } from './engine-status-storage';
import {
    acceptHeartbeat,
    afterAlertAttempt,
    lastSeqOf,
    offlineAfterMs,
    onAlarm,
    snapshotOf,
    type AlertAttempt,
    type AlertRecipient,
    type EngineStatusSnapshot,
    type HeartbeatTiming,
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
    async function sendAlert(
        status: TrackedEngineStatus,
        owed: readonly AlertRecipient[] | null,
    ): Promise<AlertAttempt> {
        let recipients: readonly AlertRecipient[];
        try {
            recipients =
                owed ?? (await deps.recipients.forEngineOffline(status.orgId, AbortSignal.timeout(SEND_TIMEOUT_MS)));
        } catch {
            return { kind: 'unresolved' };
        }
        const failed: AlertRecipient[] = [];
        for (const recipient of recipients) {
            try {
                await deps.email.send(
                    {
                        template: 'engine-offline',
                        to: recipient.email,
                        locale: recipient.locale,
                        engineId: status.engineId,
                        hostname: deps.engineHostname(status.engineId),
                        lastSeenAt: status.lastSeenAt,
                        link: deps.engineLink(status.engineId),
                    },
                    AbortSignal.timeout(SEND_TIMEOUT_MS),
                );
            } catch {
                failed.push(recipient);
            }
        }
        return failed.length === 0 ? { kind: 'delivered' } : { kind: 'partly-failed', failed };
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
                await deps.storage.save(
                    acceptHeartbeat({
                        orgId: input.orgId,
                        heartbeat: verification.heartbeat,
                        receivedAt: input.receivedAt,
                    }),
                );
                await deps.storage.setAlarm(input.receivedAt + offlineAfterMs(deps.timing));
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
                    const attempt = await sendAlert(step.status, step.status.alert.recipients);
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
            }
        },
    };
}
