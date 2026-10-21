import type { EngineId, HostnameClaim } from '@ptbk/protocol';

/** Custom hostnames with the engine's signed claim for each; D-08 adds the table, its adapter and the rows. */
export interface EngineHostnameStore {
    activeCustomHostnames(engineId: EngineId): Promise<readonly HostnameClaim[]>;
}
