import type { EngineStatsSource } from '../domain/heartbeat/engine-stats-source';
import type { EngineRuntime } from '../domain/state/engine-runtime';

/**
 * Counts from the engine API's state (M-04): agents not in the trash, as the agent list shows them by default, and
 * members who are active. The update state stays `none` until the UI loader (M-05) reports one.
 */
export function createRuntimeEngineStats(runtime: EngineRuntime): EngineStatsSource {
    return {
        counts() {
            const snapshot = runtime.controller().inspect();
            return {
                agents: snapshot.agents.filter((agent) => agent.deletedAt === null).length,
                members: snapshot.members.filter((member) => member.status === 'active').length,
            };
        },
        updateState: () => 'none',
    };
}
