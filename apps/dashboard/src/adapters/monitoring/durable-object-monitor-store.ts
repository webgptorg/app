import type { DeliveryResult } from '../../domain/monitoring/alert-outbox';
import type { JobRun, MonitorObservation, PendingAlert } from '../../domain/monitoring/alert-rules';
import type { MonitorStore } from '../../domain/monitoring/monitor-store';

/** The RPC surface of `OpsMonitor`, so this adapter does not depend on `cloudflare:workers`. */
export interface OpsMonitorStub {
    observe(observation: MonitorObservation): Promise<void>;
    recordJobRun(run: JobRun): Promise<void>;
    pending(): Promise<readonly PendingAlert[]>;
    settle(results: readonly DeliveryResult[]): Promise<readonly PendingAlert[]>;
}

export interface OpsMonitorNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): OpsMonitorStub;
}

/** The one instance, by a fixed name. */
export const OPS_MONITOR_NAME = 'ops';

export function createDurableObjectMonitorStore(namespace: OpsMonitorNamespace): MonitorStore {
    const stub = () => namespace.get(namespace.idFromName(OPS_MONITOR_NAME));
    return {
        observe: (observation) => stub().observe(observation),
        recordJobRun: (run) => stub().recordJobRun(run),
        pending: () => stub().pending(),
        settle: (results) => stub().settle(results),
    };
}
