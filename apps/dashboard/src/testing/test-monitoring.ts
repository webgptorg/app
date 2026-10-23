import { createFakeClock, type FakeClock } from '../adapters/fake-clock';
import { createMemoryLogger, type MemoryLogger } from '../adapters/memory-logger';
import {
    createMemoryDashboardMetrics,
    type MemoryDashboardMetrics,
} from '../adapters/monitoring/memory-dashboard-metrics';

/** The in-memory adapters the monitoring and scheduling domain tests run against (domain code may not import them). */
export interface MonitoringTestDeps {
    readonly clock: FakeClock;
    readonly logger: MemoryLogger;
    readonly metrics: MemoryDashboardMetrics;
}

export function createMonitoringTestDeps(startMs = 0): MonitoringTestDeps {
    const clock = createFakeClock(startMs);
    return { clock, logger: createMemoryLogger(), metrics: createMemoryDashboardMetrics(clock) };
}
