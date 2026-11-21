import { createFakeClock } from '../adapters/fake-clock';
import { createMemoryLogger, type MemoryLogger } from '../adapters/memory-logger';
import { cryptoRandom } from '../adapters/crypto-random';
import type { FakeClock } from '../adapters/fake-clock';
import { createUsageRecorder, type UsageRecorder } from '../domain/usage/usage-recorder';
import type { UsageStore } from '../domain/usage/usage-store';
import { createMemoryUsageStore, type MemoryUsageStore } from './memory-usage-store';

export const USAGE_TEST_NOW_MS = 1_800_000_000_000;

/** A usage recorder over an in-memory store, or over `store` (one that fails, say), with its log. */
export function createTestUsage(
    options: { readonly store?: Pick<UsageStore, 'insertEvents'>; readonly logger?: MemoryLogger } = {},
): {
    readonly store: MemoryUsageStore;
    readonly logger: MemoryLogger;
    readonly clock: FakeClock;
    readonly recorder: UsageRecorder;
} {
    const store = createMemoryUsageStore();
    const logger = options.logger ?? createMemoryLogger();
    const clock = createFakeClock(USAGE_TEST_NOW_MS);
    const recorder = createUsageRecorder({ store: options.store ?? store, clock, random: cryptoRandom, logger });
    return { store, logger, clock, recorder };
}
