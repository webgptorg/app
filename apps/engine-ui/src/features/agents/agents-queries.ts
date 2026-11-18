import { MAX_PAGE_LIMIT } from '@ptbk/engine-api';
import type { AgentId, EngineApiClient, MemberId, ProblemDetails } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { agentKeys } from './agents-keys';
import type { AgentListParams } from './agents-keys';

/** Agent records change through this UI or arrive as `agent.changed` events, so a short freshness window is enough. */
const AGENT_STALE_MS = 30_000;

export function agentListQueryOptions(engineApi: EngineApiClient, params: AgentListParams) {
    return queryOptions({
        queryKey: agentKeys.list(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.agents.list(params, signal)),
        staleTime: AGENT_STALE_MS,
    });
}

export function agentDetailQueryOptions(engineApi: EngineApiClient, agentId: AgentId) {
    return queryOptions({
        queryKey: agentKeys.detail(agentId),
        queryFn: async ({ signal }) => unwrap(await engineApi.agents.get(agentId, signal)),
        staleTime: AGENT_STALE_MS,
    });
}

/**
 * The draft run state (C-04), or `null` when the engine does not offer it. `agent.status` events write into this entry
 * and a reconnect of the stream invalidates it, so it never goes stale on a timer.
 *
 * An engine may serve no draft route (the Reborn engine answers 404 for every agent), so a 404 or
 * `capability-not-supported` is cached as `null` rather than thrown: an error with no data would be refetched by every
 * card that mounts and on every window focus, one request per agent each time.
 */
export function agentStatusQueryOptions(engineApi: EngineApiClient, agentId: AgentId) {
    return queryOptions({
        queryKey: agentKeys.status(agentId),
        queryFn: async ({ signal }) => {
            const response = await engineApi.agents.getStatus(agentId, signal);
            if (response.kind === 'problem' && isUnsupported(response.problem)) return null;
            return unwrap(response);
        },
        staleTime: Number.POSITIVE_INFINITY,
    });
}

function isUnsupported(problem: ProblemDetails): boolean {
    return problem.status === 404 || problem.code === 'capability-not-supported';
}

/** When the newest activity the member may see for this agent happened, or `null`. */
export function agentLastActivityQueryOptions(engineApi: EngineApiClient, agentId: AgentId) {
    return queryOptions({
        queryKey: agentKeys.lastActivity(agentId),
        queryFn: async ({ signal }) => {
            const [item] = unwrap(await engineApi.activity.list({ agentId, limit: 1 }, signal)).items;
            if (item === undefined) return null;
            return item.kind === 'known' ? item.activity.at : item.base.at;
        },
        staleTime: AGENT_STALE_MS,
    });
}

/** The agent's most recent run (`runs@1`), for the model it ran on; `null` before its first run. */
export function agentLatestRunQueryOptions(engineApi: EngineApiClient, agentId: AgentId) {
    return queryOptions({
        queryKey: agentKeys.latestRun(agentId),
        queryFn: async ({ signal }) => {
            const page = unwrap(await engineApi.runs.list({ agentId, limit: 1 }, signal));
            return page.items[0] ?? null;
        },
        staleTime: AGENT_STALE_MS,
    });
}

export function agentCreatorQueryOptions(engineApi: EngineApiClient, memberId: MemberId) {
    return queryOptions({
        queryKey: agentKeys.creator(memberId),
        queryFn: async ({ signal }) => unwrap(await engineApi.members.get(memberId, signal)),
        // Display names change rarely; a stale one is harmless.
        staleTime: 5 * 60_000,
    });
}

/**
 * The engine's agent folders, for the list's Folder filter: one page of the most there may be. An engine without
 * folders answers with none (or an error), and the filter is simply not offered.
 */
export function folderListQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: agentKeys.folders(),
        queryFn: async ({ signal }) => unwrap(await engineApi.folders.list({ limit: MAX_PAGE_LIMIT }, signal)).items,
        staleTime: 5 * 60_000,
        retry: false,
    });
}
