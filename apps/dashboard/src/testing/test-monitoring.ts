import { createFakeClock, type FakeClock } from '../adapters/fake-clock';
import { createMemoryLogger, type MemoryLogger } from '../adapters/memory-logger';
import {
    createMemoryDashboardMetrics,
    type MemoryDashboardMetrics,
} from '../adapters/monitoring/memory-dashboard-metrics';
import { DEFAULT_THRESHOLDS, type Alert, type MonitorState } from '../domain/monitoring/alert-rules';
import { createMonitorService, type MonitorStore } from '../domain/monitoring/monitor-store';

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

/** The monitor store over memory, as the `OpsMonitor` object runs it; `alerts()` lists what is queued. */
export function createMemoryMonitor(): MonitorStore & { readonly alerts: () => Promise<readonly Alert[]> } {
    let state: MonitorState | null = null;
    const service = createMonitorService({
        storage: {
            load: () => Promise.resolve(state),
            save: (next) => {
                state = next;
                return Promise.resolve();
            },
        },
        thresholds: DEFAULT_THRESHOLDS,
    });
    return { ...service, alerts: async () => (await service.pending()).map((pending) => pending.alert) };
}
