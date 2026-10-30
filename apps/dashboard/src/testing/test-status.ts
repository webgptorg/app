import { defaultHostname, Ed25519PublicKey } from '@ptbk/protocol';

import { createFakeEmailSender, type FakeEmailSender } from '../adapters/email/fake-email-sender';
import { createFakeClock, type FakeClock } from '../adapters/fake-clock';
import { createMemoryLogger, type MemoryLogger } from '../adapters/memory-logger';
import type { OrgId } from '../domain/ids';
import type { EngineStatus } from '../domain/registration/engine-store';
import type { EmailMessage, EmailSender } from '../domain/ports/email-sender';
import type { AlertRecipient, HeartbeatTiming } from '../domain/status/engine-status';
import type { EngineStatusServiceDeps } from '../domain/status/engine-status-service';
import type { EngineLabel } from '../shared/engine-label';
import { testOrgId } from './billing-fixtures';
import { createMemoryEngineStatusStorage, type MemoryEngineStatusStorage } from './memory-engine-status';
import { TEST_ENGINE_DOMAIN } from './test-engine';

export const STATUS_START_MS = 1_800_000_000_000;
export const DEFAULT_TIMING: HeartbeatTiming = { intervalS: 60, missedLimit: 3, graceS: 15, perEngineLimit: 5 };
// The status object reads only the engine's status and label from the row; the rest is a placeholder.
const PLACEHOLDER_KEY = Ed25519PublicKey.parse('A'.repeat(43));

/** An outbox whose sends to `failing` addresses reject, until they are removed from the set. */
export interface FlakyOutbox extends EmailSender {
    readonly outbox: FakeEmailSender;
    readonly failing: Set<string>;
    readonly attempts: EmailMessage[];
}

export function createFlakyOutbox(): FlakyOutbox {
    const outbox = createFakeEmailSender();
    const failing = new Set<string>();
    const attempts: EmailMessage[] = [];
    return {
        outbox,
        failing,
        attempts,
        send(message, signal) {
            attempts.push(message);
            return failing.has(message.to)
                ? Promise.reject(new Error('provider refused'))
                : outbox.send(message, signal);
        },
    };
}

/**
 * One engine's status service deps on in-memory adapters; `recipients` maps organizations to their owners, and
 * `engineStatus` is the engine row's status (active unless it says otherwise; null for a removed engine).
 */
export function createStatusTestDeps(
    options: {
        readonly recipients?: ReadonlyMap<OrgId, readonly AlertRecipient[]>;
        readonly recipientsFail?: () => boolean;
        readonly engineStatus?: () => Promise<EngineStatus | null>;
        readonly engineLabel?: EngineLabel;
    } = {},
): {
    readonly deps: EngineStatusServiceDeps;
    readonly clock: FakeClock;
    readonly logger: MemoryLogger;
    readonly email: FlakyOutbox;
    readonly storage: MemoryEngineStatusStorage;
} {
    const clock = createFakeClock(STATUS_START_MS);
    const logger = createMemoryLogger();
    const email = createFlakyOutbox();
    const storage = createMemoryEngineStatusStorage();
    return {
        clock,
        logger,
        email,
        storage,
        deps: {
            storage,
            clock,
            logger,
            timing: DEFAULT_TIMING,
            heartbeatEngines: {
                async findEngine() {
                    const status = await (options.engineStatus?.() ?? Promise.resolve('active'));
                    return status === null
                        ? null
                        : {
                              orgId: testOrgId(),
                              publicKey: PLACEHOLDER_KEY,
                              status,
                              label: options.engineLabel ?? null,
                          };
                },
            },
            recipients: {
                forEngineStatus: (orgId) =>
                    options.recipientsFail?.() === true
                        ? Promise.reject(new Error('database unavailable'))
                        : Promise.resolve(options.recipients?.get(orgId) ?? []),
            },
            email,
            engineHostname: (engineId) => defaultHostname(engineId, TEST_ENGINE_DOMAIN),
            engineLink: (engineId) => `https://app.ptbk.test/engines/${engineId}`,
        },
    };
}
