import type { Alert, AlertThresholds, JobRun, MonitorObservation, MonitorState } from './alert-rules';
import { INITIAL_MONITOR_STATE, evaluateAlerts, recordJobRun } from './alert-rules';

/** The alert state: one Durable Object in production, so runs never interleave and an alert starts and ends once. */
export interface MonitorStore {
    /** Applies one monitoring run; resolves with the alerts that start or end with it. */
    observe(observation: MonitorObservation): Promise<readonly Alert[]>;
    /** Applies one scheduled job's run; resolves with the job-failure alert it starts or ends, if any. */
    recordJobRun(run: JobRun): Promise<readonly Alert[]>;
}

/** The storage behind the store: the object's own storage, or memory in tests. */
export interface MonitorStateStorage {
    load(): Promise<MonitorState | null>;
    save(state: MonitorState): Promise<void>;
}

export function createMonitorService(deps: {
    readonly storage: MonitorStateStorage;
    readonly thresholds: AlertThresholds;
}): MonitorStore {
    const { storage, thresholds } = deps;
    return {
        async observe(observation) {
            const next = evaluateAlerts((await storage.load()) ?? INITIAL_MONITOR_STATE, observation, thresholds);
            await storage.save(next.state);
            return next.alerts;
        },
        async recordJobRun(run) {
            const next = recordJobRun((await storage.load()) ?? INITIAL_MONITOR_STATE, run, thresholds);
            await storage.save(next.state);
            return next.alerts;
        },
    };
}
