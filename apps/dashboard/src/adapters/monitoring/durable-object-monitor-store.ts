import type { Alert, JobRun, MonitorObservation } from '../../domain/monitoring/alert-rules';
import type { MonitorStore } from '../../domain/monitoring/monitor-store';

/** The RPC surface of `OpsMonitor`, so this adapter does not depend on `cloudflare:workers`. */
export interface OpsMonitorStub {
    observe(observation: MonitorObservation): Promise<readonly Alert[]>;
    recordJobRun(run: JobRun): Promise<readonly Alert[]>;
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
    };
}
