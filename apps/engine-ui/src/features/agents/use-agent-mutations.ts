import type { Agent, AgentId, AgentPage, AgentRunStatus, AgentVisibility } from '@ptbk/engine-api';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { visibilityLabel } from './agent-badges';
import { writeAgentStatus } from './agent-status-cache';
import { agentKeys } from './agents-keys';

type AgentPageData = z.output<typeof AgentPage>;

/** The agent a mutation acts on; the name is for messages only. */
export interface AgentTarget {
    readonly id: AgentId;
    readonly name: string;
}

export interface VisibilityChange extends AgentTarget {
    readonly visibility: AgentVisibility;
}

interface VisibilitySnapshot {
    readonly lists: readonly (readonly [QueryKey, AgentPageData | undefined])[];
    readonly detail: Agent | undefined;
    readonly agentId: AgentId;
}

/** Mutations are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const MUTATION_TIMEOUT_MS = 30_000;

const INVALIDATES = [agentKeys.lists(), agentKeys.details()] as const;

function applyVisibility(change: VisibilityChange, queryClient: QueryClient): VisibilitySnapshot {
    const snapshot: VisibilitySnapshot = {
        lists: queryClient.getQueriesData<AgentPageData>({ queryKey: agentKeys.lists() }),
        detail: queryClient.getQueryData<Agent>(agentKeys.detail(change.id)),
        agentId: change.id,
    };
    const withVisibility = (agent: Agent): Agent =>
        agent.id === change.id ? { ...agent, visibility: change.visibility } : agent;
    queryClient.setQueriesData<AgentPageData>({ queryKey: agentKeys.lists() }, (page) =>
        page === undefined ? page : { ...page, items: page.items.map(withVisibility) },
    );
    if (snapshot.detail !== undefined) {
        queryClient.setQueryData(agentKeys.detail(change.id), withVisibility(snapshot.detail));
    }
    return snapshot;
}

function rollbackVisibility(snapshot: VisibilitySnapshot, queryClient: QueryClient): void {
    for (const [queryKey, page] of snapshot.lists) queryClient.setQueryData(queryKey, page);
    queryClient.setQueryData(agentKeys.detail(snapshot.agentId), snapshot.detail);
}

export interface AgentMutationOptions {
    /** After the engine confirmed a delete, e.g. to leave the deleted agent's page. */
    readonly onDeleted?: (agent: Agent) => void;
}

/**
 * Every change to an agent goes through here, so the draft run-control route (C-04) is touched in one place. The
 * visibility change is optimistic; stop and delete wait for the engine.
 */
export function useAgentMutations(options: AgentMutationOptions = {}) {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const setStatus = (agentId: AgentId, status: AgentRunStatus) => {
        writeAgentStatus(queryClient, agentId, status);
    };

    const stop = useStepUpAwareMutation({
        mutationFn: async (agent: AgentTarget) =>
            unwrap(await engineApi.agents.stop(agent.id, AbortSignal.timeout(MUTATION_TIMEOUT_MS))),
        invalidates: INVALIDATES,
        successMessage: (_, agent) => m.agent_stopped({ name: agent.name }),
        errorMessage: () => m.agent_stop_failed(),
        onSuccess: (status, agent) => {
            setStatus(agent.id, status);
        },
    });

    const setVisibility = useStepUpAwareMutation({
        mutationFn: async (change: VisibilityChange) =>
            unwrap(
                await engineApi.agents.update(
                    change.id,
                    { visibility: change.visibility },
                    AbortSignal.timeout(MUTATION_TIMEOUT_MS),
                ),
            ),
        invalidates: INVALIDATES,
        optimistic: { apply: applyVisibility, rollback: rollbackVisibility },
        successMessage: (_, change) =>
            m.agent_visibility_changed({ name: change.name, visibility: visibilityLabel(change.visibility) }),
        errorMessage: () => m.agent_visibility_failed(),
    });

    const remove = useStepUpAwareMutation({
        mutationFn: async (agent: AgentTarget) =>
            unwrap(await engineApi.agents.delete(agent.id, AbortSignal.timeout(MUTATION_TIMEOUT_MS))),
        invalidates: INVALIDATES,
        successMessage: (_, agent) => m.agent_deleted({ name: agent.name }),
        errorMessage: () => m.agent_delete_failed(),
        ...(options.onDeleted === undefined ? {} : { onSuccess: options.onDeleted }),
    });

    return { stop, setVisibility, remove };
}
