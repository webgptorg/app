import { MAX_PAGE_LIMIT, Timestamp } from '@ptbk/engine-api';
import type { ReadRun } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';

import { classifyApiError, unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import type { AgentStopControl, AgentStopTarget } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { restoreRun, snapshotRun, updateCachedRun } from './run-cache';
import type { RunCacheSnapshot } from './run-cache';
import { useRunAgentLiveState } from './run-agent-state';
import { canCancel } from './use-run-mutations';
import { runListQueryOptions } from './runs-queries';
import { runKeys } from './runs-keys';

const MUTATION_TIMEOUT_MS = 30_000;

interface StopVariables {
    readonly agent: AgentStopTarget;
    readonly runs: readonly ReadRun[];
}

async function cancelIgnoringFinished(cancel: () => Promise<unknown>): Promise<void> {
    try {
        await cancel();
    } catch (error) {
        // A run that finished between the list and the click has nothing left to stop.
        const failure = classifyApiError(error);
        if (failure.kind === 'problem' && failure.problem.code === 'run-finished') return;
        throw error;
    }
}

/**
 * Stops an agent by cancelling every run it has running or queued (C-07 has no agent-level stop). The runs are listed
 * only while the agent's counts say it has work, so an idle agent costs no request; a page holds the engine's maximum,
 * and anything beyond it keeps the control on "Stop" for a second click.
 */
export function useRunAgentStop(agent: AgentStopTarget): AgentStopControl | null {
    const engineApi = useEngineApi();
    const allowed = usePermissions().can('runs.control');
    const liveState = useRunAgentLiveState(agent.id);
    const busy = liveState === 'working' || liveState === 'waiting';
    const active = useQuery({
        ...runListQueryOptions(engineApi, { agentId: agent.id, status: 'queued,running', limit: MAX_PAGE_LIMIT }),
        enabled: allowed && busy,
    });
    const stop = useStepUpAwareMutation<number, StopVariables, readonly RunCacheSnapshot[]>({
        mutationFn: async ({ runs }) => {
            await Promise.all(
                runs.map((run) =>
                    cancelIgnoringFinished(async () =>
                        unwrap(await engineApi.runs.cancel(run.id, AbortSignal.timeout(MUTATION_TIMEOUT_MS))),
                    ),
                ),
            );
            return runs.length;
        },
        invalidates: [runKeys.lists(), runKeys.details(), runKeys.allStats()],
        optimistic: {
            apply: ({ runs }, client) => {
                const requestedAt = Timestamp.parse(new Date().toISOString());
                return runs.map((run) => {
                    const snapshot = snapshotRun(client, run.id);
                    updateCachedRun(client, run.id, (cached) => ({ ...cached, cancelRequestedAt: requestedAt }));
                    return snapshot;
                });
            },
            rollback: (snapshots, client) => {
                for (const snapshot of snapshots) restoreRun(client, snapshot);
            },
        },
        successMessage: (_, { agent: target }) => m.agent_stopped({ name: target.name }),
        errorMessage: () => m.agent_stop_failed(),
    });

    if (!allowed) return null;
    const runs = busy ? (active.data?.items ?? []) : [];
    const stoppable = runs.filter(canCancel);
    const state = runs.length === 0 ? 'none' : stoppable.length > 0 ? 'stoppable' : 'stopping';
    return {
        state,
        isPending: stop.isPending,
        stop: () => {
            if (stoppable.length > 0 && !stop.isPending) stop.mutate({ agent, runs: stoppable });
        },
    };
}
