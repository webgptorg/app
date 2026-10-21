import type { EngineId, HeartbeatVerification } from '@ptbk/protocol';

import type { EngineStatusSnapshot } from '../../domain/status/engine-status';
import type { EngineStatusDirectory, RecordHeartbeatInput } from '../../domain/status/engine-status-directory';

/** The RPC surface of `EngineStatus`, so this adapter does not depend on `cloudflare:workers`. */
export interface EngineStatusStub {
    recordHeartbeat(input: RecordHeartbeatInput): Promise<HeartbeatVerification>;
    getStatus(): Promise<EngineStatusSnapshot>;
    reset(): Promise<void>;
}

export interface EngineStatusNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): EngineStatusStub;
}

/** One `EngineStatus` Durable Object per engine, named by its engine ID. */
export function createDurableObjectEngineStatus(namespace: EngineStatusNamespace): EngineStatusDirectory {
    const stub = (engineId: EngineId) => namespace.get(namespace.idFromName(engineId));
    return {
        recordHeartbeat: (input) => stub(input.engineId).recordHeartbeat(input),
        getStatus: (engineId) => stub(engineId).getStatus(),
        reset: (engineId) => stub(engineId).reset(),
    };
}
