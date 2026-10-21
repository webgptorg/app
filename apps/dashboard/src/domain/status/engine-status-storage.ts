import type { StoredEngineStatus } from './engine-status';

/** One engine's storage and alarm: its Durable Object's, or memory in tests. Calls for one engine never interleave. */
export interface EngineStatusStorage {
    load(): Promise<StoredEngineStatus | null>;
    save(status: StoredEngineStatus): Promise<void>;
    /** Replaces the engine's one alarm. */
    setAlarm(at: number): Promise<void>;
    /** Deletes the status and the alarm. */
    deleteAll(): Promise<void>;
}
