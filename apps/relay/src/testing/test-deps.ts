import type { FakeClock } from '../adapters/fake-clock';
import { createFakeClock } from '../adapters/fake-clock';
import type { InMemoryDnsResolver } from '../adapters/in-memory-dns-resolver';
import { createInMemoryDnsResolver } from '../adapters/in-memory-dns-resolver';
import type { InMemoryRegistry } from '../adapters/in-memory-registry';
import { createInMemoryRegistry } from '../adapters/in-memory-registry';
import type { MemoryLogger } from '../adapters/memory-logger';
import { createMemoryLogger } from '../adapters/memory-logger';
import type { MemoryMetrics } from './memory-metrics';
import { createMemoryMetrics } from './memory-metrics';

export const START_MS = 1_700_000_000_000;

/** The in-memory adapters domain tests run against; domain code itself may not import adapters. */
export interface TestDeps {
    readonly clock: FakeClock;
    readonly logger: MemoryLogger;
    readonly metrics: MemoryMetrics;
    readonly registry: InMemoryRegistry;
    readonly dns: InMemoryDnsResolver;
}

export function createTestDeps(startMs = START_MS): TestDeps {
    return {
        clock: createFakeClock(startMs),
        logger: createMemoryLogger(),
        metrics: createMemoryMetrics(),
        registry: createInMemoryRegistry(),
        dns: createInMemoryDnsResolver(),
    };
}
