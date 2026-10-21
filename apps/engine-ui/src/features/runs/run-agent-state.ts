import type { AgentId, RunStats } from '@ptbk/engine-api';

import type { AgentLiveState } from '../../app/registry/feature';
import { useRunStats } from './runs-queries';

/**
 * An agent's state from its runs (C-07 stores none): working while any run runs, waiting while any is queued, failed
 * when its last finished run failed within the last 24 hours (the engine's `failedLast24h` window), else idle. The
 * 24-hour window is a UI choice still to be confirmed (U-09, Risks).
 */
export function agentStateFromStats(stats: RunStats): AgentLiveState {
    if (stats.running > 0) return 'working';
    if (stats.queued > 0) return 'waiting';
    if (stats.failedLast24h > 0 && stats.lastFinished?.status === 'failed') return 'failed';
    return 'idle';
}

/** `null` until the counts arrive; `run.changed` events refetch them, so the state follows without polling. */
export function useRunAgentLiveState(agentId: AgentId): AgentLiveState | null {
    const stats = useRunStats(agentId);
    return stats.data === undefined ? null : agentStateFromStats(stats.data);
}
