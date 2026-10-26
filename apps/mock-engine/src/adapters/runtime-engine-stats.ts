import type { EngineStatsSource } from '../domain/heartbeat/engine-stats-source';
import { membersWhoCanSignIn } from '../domain/onboarding/owner';
import type { EngineRuntime } from '../domain/state/engine-runtime';

/**
 * Counts from the engine API's state (M-04): agents not in the trash, as the agent list shows them by default, and
 * active members who hold a passkey, so the dashboard can tell an engine still waiting for its owner. The update state
 * stays `none` until the UI loader (M-05) reports one.
 */
export function createRuntimeEngineStats(runtime: EngineRuntime): EngineStatsSource {
    return {
        counts() {
            const snapshot = runtime.controller().inspect();
            return {
                agents: snapshot.agents.filter((agent) => agent.deletedAt === null).length,
                members: membersWhoCanSignIn(snapshot),
            };
        },
        updateState: () => 'none',
    };
}
