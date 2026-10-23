import type { AlertThresholds, JobRun, MonitorObservation, MonitorState, PendingAlert } from './alert-rules';
import { INITIAL_MONITOR_STATE, evaluateAlerts, recordJobRun } from './alert-rules';
import type { DeliveryResult } from './alert-outbox';
import { enqueueAlerts, settleAlerts } from './alert-outbox';

/**
 * The alert state: one Durable Object in production, so runs never interleave and an alert starts and ends once.
 * Alerts that start or end are queued, not returned: a delivery that fails is retried on the next run.
 */
export interface MonitorStore {
    /** Applies one monitoring run and queues the alerts that start or end with it. */
    observe(observation: MonitorObservation): Promise<void>;
    /** Applies one scheduled job's run and queues the job-failure alert it starts or ends, if any. */
    recordJobRun(run: JobRun): Promise<void>;
    /** The alerts waiting to be delivered, oldest first. */
    pending(): Promise<readonly PendingAlert[]>;
    /** Takes delivered alerts out of the queue; resolves with those dropped after too many failed attempts. */
    settle(results: readonly DeliveryResult[]): Promise<readonly PendingAlert[]>;
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
    const load = async (): Promise<MonitorState> => (await storage.load()) ?? INITIAL_MONITOR_STATE;
    return {
        async observe(observation) {
            const next = evaluateAlerts(await load(), observation, thresholds);
            await storage.save(enqueueAlerts(next.state, next.alerts));
        },
        async recordJobRun(run) {
            const next = recordJobRun(await load(), run, thresholds);
            await storage.save(enqueueAlerts(next.state, next.alerts));
        },
        async pending() {
            return (await load()).outbox;
        },
        async settle(results) {
            const next = settleAlerts(await load(), results);
            await storage.save(next.state);
            return next.dropped;
        },
    };
}
