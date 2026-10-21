import type { AgentId, EngineApiClient, RunId } from '@ptbk/engine-api';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { runKeys } from './runs-keys';
import type { RunListParams } from './runs-keys';

/**
 * Runs change on the engine's side all the time, and every change arrives as a `run.changed` event that invalidates
 * what it touches, so nothing here goes stale on a timer and nothing polls.
 */
const RUN_STALE_MS = Number.POSITIVE_INFINITY;

/** `GET /runs`, newest first; every filter and the paging happen on the engine. */
export function runListQueryOptions(engineApi: EngineApiClient, params: RunListParams) {
    return queryOptions({
        queryKey: runKeys.list(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.runs.list(params, signal)),
        staleTime: RUN_STALE_MS,
    });
}

/** `GET /runs/{runId}`: the run with its tool calls, outputs and report. */
export function runQueryOptions(engineApi: EngineApiClient, runId: RunId) {
    return queryOptions({
        queryKey: runKeys.detail(runId),
        queryFn: async ({ signal }) => unwrap(await engineApi.runs.get(runId, signal)),
        staleTime: RUN_STALE_MS,
    });
}

/** `GET /runs/stats`, for one agent or (without `agentId`) the whole engine. */
export function runStatsQueryOptions(engineApi: EngineApiClient, agentId?: AgentId) {
    return queryOptions({
        queryKey: runKeys.stats(agentId ?? null),
        queryFn: async ({ signal }) =>
            unwrap(await engineApi.runs.stats(agentId === undefined ? {} : { agentId }, signal)),
        staleTime: RUN_STALE_MS,
    });
}

/** One page of runs; the previous page stays on screen while the next one loads. */
export function useRunList(params: RunListParams) {
    return useQuery({
        ...runListQueryOptions(useEngineApi(), params),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevelFailure,
    });
}

export function useRunStats(agentId?: AgentId) {
    return useQuery(runStatsQueryOptions(useEngineApi(), agentId));
}
