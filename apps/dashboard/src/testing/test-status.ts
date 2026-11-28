import { Ed25519PublicKey } from '@ptbk/protocol';

import { createFakeClock, type FakeClock } from '../adapters/fake-clock';
import { createMemoryLogger, type MemoryLogger } from '../adapters/memory-logger';
import type { EngineStatus } from '../domain/registration/engine-store';
import type { HeartbeatTiming } from '../domain/status/engine-status';
import type { EngineStatusServiceDeps } from '../domain/status/engine-status-service';
import type { EngineLabel } from '../shared/engine-label';
import { testOrgId } from './billing-fixtures';
import { createMemoryEngineStatusStorage, type MemoryEngineStatusStorage } from './memory-engine-status';
import { cryptoRandom } from '../adapters/crypto-random';
import { createUsageRecorder } from '../domain/usage/usage-recorder';
import { createMemoryUsageStore, type MemoryUsageStore } from './memory-usage-store';

export const STATUS_START_MS = 1_800_000_000_000;
export const DEFAULT_TIMING: HeartbeatTiming = { intervalS: 60, missedLimit: 3, graceS: 15, perEngineLimit: 5 };
// The status object reads only the engine's status and label from the row; the rest is a placeholder.
const PLACEHOLDER_KEY = Ed25519PublicKey.parse('A'.repeat(43));

/** A notification call the status object made; `attention` stands for `syncAttention`. */
export interface NotifyCall {
    readonly kind: 'project-status' | 'update-waiting' | 'attention';
    readonly orgId: string;
    readonly engineId: string | null;
    readonly event: unknown;
}

/** Records the status object's `notify` calls; every call fails while `failing` is set. */
export interface RecordingNotifications {
    readonly calls: NotifyCall[];
    failing: boolean;
    notify: EngineStatusServiceDeps['notifications']['notify'];
    syncAttention: EngineStatusServiceDeps['notifications']['syncAttention'];
}

export function createRecordingNotifications(): RecordingNotifications {
    const recorder: RecordingNotifications = {
        calls: [],
        failing: false,
        notify(kind, target, event) {
            if (recorder.failing) {
                return Promise.reject(new Error('database unavailable'));
            }
            recorder.calls.push({
                kind: kind as NotifyCall['kind'],
                orgId: target.orgId,
                engineId: target.engineId,
                event,
            });
            return Promise.resolve();
        },
        syncAttention(target, entries) {
            if (recorder.failing) {
                return Promise.reject(new Error('database unavailable'));
            }
            recorder.calls.push({ kind: 'attention', orgId: target.orgId, engineId: target.engineId, event: entries });
            return Promise.resolve();
        },
    };
    return recorder;
}

/**
 * One engine's status service deps on in-memory adapters; `engineStatus` is the engine row's status (active unless it
 * says otherwise; null for a removed engine).
 */
export function createStatusTestDeps(
    options: {
        readonly engineStatus?: () => Promise<EngineStatus | null>;
        readonly engineLabel?: EngineLabel;
    } = {},
): {
    readonly deps: EngineStatusServiceDeps;
    readonly clock: FakeClock;
    readonly logger: MemoryLogger;
    readonly notifications: RecordingNotifications;
    readonly storage: MemoryEngineStatusStorage;
    readonly usage: MemoryUsageStore;
} {
    const clock = createFakeClock(STATUS_START_MS);
    const logger = createMemoryLogger();
    const notifications = createRecordingNotifications();
    const storage = createMemoryEngineStatusStorage();
    const usage = createMemoryUsageStore();
    return {
        clock,
        logger,
        notifications,
        storage,
        usage,
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
            notifications,
            usage: createUsageRecorder({ store: usage, clock, random: cryptoRandom, logger }),
        },
    };
}
