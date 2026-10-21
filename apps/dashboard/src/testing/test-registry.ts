import { cryptoRandom } from '../adapters/crypto-random';
import { createFakeClock, type FakeClock } from '../adapters/fake-clock';
import { createMemoryLogger, type MemoryLogger } from '../adapters/memory-logger';
import type { Random } from '../domain/ports/random';

export const REGISTRY_START_MS = 1_800_000_000_000;

/** The adapters D-04's domain tests run on; domain code itself may not import adapters. */
export function createRegistryTestDeps(): {
    readonly clock: FakeClock;
    readonly logger: MemoryLogger;
    readonly random: Random;
} {
    return { clock: createFakeClock(REGISTRY_START_MS), logger: createMemoryLogger(), random: cryptoRandom };
}
