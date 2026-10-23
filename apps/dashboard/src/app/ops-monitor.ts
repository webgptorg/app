import { DEFAULT_THRESHOLDS } from '../domain/monitoring/alert-rules';
import { createMonitorService, type MonitorStateStorage, type MonitorStore } from '../domain/monitoring/monitor-store';
import { parseConfig } from './config';

/** The composition root of the `OpsMonitor` object: the thresholds come from the same config as the Worker's. */
export function createOpsMonitor(env: Env, storage: MonitorStateStorage): MonitorStore {
    const config = parseConfig(env);
    return createMonitorService({ storage, thresholds: config.monitoring?.thresholds ?? DEFAULT_THRESHOLDS });
}
