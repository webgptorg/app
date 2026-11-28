import type { EngineId } from '@ptbk/protocol';

import type { EngineStore } from '../domain/registration/engine-store';
import { storedEngineStatusSchema, type StoredEngineStatus } from '../domain/status/engine-status';
import type { EngineStatusDirectory } from '../domain/status/engine-status-directory';
import {
    createEngineStatusService,
    type EngineStatusService,
    type EngineStatusServiceDeps,
} from '../domain/status/engine-status-service';
import type { EngineStatusStorage } from '../domain/status/engine-status-storage';
import type { HeartbeatEngineReader } from '../domain/status/heartbeat-engine-reader';

/** One engine's storage in memory, round-tripped through the schema as the Durable Object's is. */
export interface MemoryEngineStatusStorage extends EngineStatusStorage {
    stored(): StoredEngineStatus | null;
    alarmAt(): number | null;
    /** What the runtime does when the alarm fires: returns its time and clears it, so the handler sets the next. */
    takeAlarm(): number | null;
}

export function createMemoryEngineStatusStorage(): MemoryEngineStatusStorage {
    let value: unknown = undefined;
    let alarm: number | null = null;
    const stored = () => (value === undefined ? null : storedEngineStatusSchema.parse(value));
    return {
        stored,
        alarmAt: () => alarm,
        takeAlarm() {
            const at = alarm;
            alarm = null;
            return at;
        },
        load: () => Promise.resolve(stored()),
        save(status) {
            value = structuredClone(status);
            return Promise.resolve();
        },
        setAlarm(at) {
            alarm = at;
            return Promise.resolve();
        },
        deleteAll() {
            value = undefined;
            alarm = null;
            return Promise.resolve();
        },
    };
}

/** Stands in for the `EngineStatus` namespace: one service per engine, alarms fired by hand. */
export interface MemoryEngineStatuses extends EngineStatusDirectory {
    storage(engineId: EngineId): MemoryEngineStatusStorage;
    /** Like `runDurableObjectAlarm`: runs the engine's alarm if one is set, and says whether it ran. */
    runAlarm(engineId: EngineId): Promise<boolean>;
}

export function createMemoryEngineStatuses(deps: Omit<EngineStatusServiceDeps, 'storage'>): MemoryEngineStatuses {
    const objects = new Map<EngineId, { storage: MemoryEngineStatusStorage; service: EngineStatusService }>();
    const object = (engineId: EngineId) => {
        let entry = objects.get(engineId);
        if (entry === undefined) {
            const storage = createMemoryEngineStatusStorage();
            entry = { storage, service: createEngineStatusService({ ...deps, storage }) };
            objects.set(engineId, entry);
        }
        return entry;
    };
    return {
        storage: (engineId) => object(engineId).storage,
        recordHeartbeat: (input) => object(input.engineId).service.recordHeartbeat(input),
        getStatus: (engineId) => object(engineId).service.getStatus(),
        getActivity: (engineId) => object(engineId).service.getActivity(),
        reset: (engineId) => object(engineId).service.reset(),
        async runAlarm(engineId) {
            const { storage, service } = object(engineId);
            if (storage.takeAlarm() === null) {
                return false;
            }
            await service.alarm();
            return true;
        },
    };
}

/** The heartbeat's view of the engines another store holds, as the D1 reader reads the same table. */
export function createMemoryHeartbeatEngineReader(
    engines: Pick<EngineStore, 'findForRegistration'>,
): HeartbeatEngineReader {
    return {
        async findEngine(engineId) {
            const engine = await engines.findForRegistration(engineId);
            return engine === null
                ? null
                : { orgId: engine.orgId, publicKey: engine.publicKey, status: engine.status, label: engine.label };
        },
    };
}
