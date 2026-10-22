import { DEFAULT_PAGE_LIMIT } from '@ptbk/engine-api';
import type { AgentId, EngineApiClient, TriggerId } from '@ptbk/engine-api';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { triggerKeys } from './triggers-keys';
import type { TriggerListParams } from './triggers-keys';

/**
 * Every change to a trigger arrives as a `trigger.changed` event (and fires as `trigger.*` activity) that invalidates
 * what it touches, so nothing here goes stale on a timer and nothing polls.
 */
const TRIGGER_STALE_MS = Number.POSITIVE_INFINITY;

/** `GET /triggers`, newest first; every filter and the paging happen on the engine. */
export function triggerListQueryOptions(engineApi: EngineApiClient, params: TriggerListParams) {
    return queryOptions({
        queryKey: triggerKeys.list(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.triggers.list(params, signal)),
        staleTime: TRIGGER_STALE_MS,
    });
}

export function triggerQueryOptions(engineApi: EngineApiClient, triggerId: TriggerId) {
    return queryOptions({
        queryKey: triggerKeys.detail(triggerId),
        queryFn: async ({ signal }) => unwrap(await engineApi.triggers.get(triggerId, signal)),
        staleTime: TRIGGER_STALE_MS,
    });
}

/** One page of a trigger's fire history, newest first; `null` is the first page. */
export function triggerFiresQueryOptions(engineApi: EngineApiClient, triggerId: TriggerId, cursor: string | null) {
    return queryOptions({
        queryKey: triggerKeys.fires(triggerId, cursor),
        queryFn: async ({ signal }) =>
            unwrap(
                await engineApi.triggers.listFires(
                    triggerId,
                    { limit: DEFAULT_PAGE_LIMIT, ...(cursor === null ? {} : { cursor }) },
                    signal,
                ),
            ),
        staleTime: TRIGGER_STALE_MS,
    });
}

/** `GET /triggers/stats`, for one agent or (without `agentId`) the whole engine. */
export function triggerStatsQueryOptions(engineApi: EngineApiClient, agentId?: AgentId) {
    return queryOptions({
        queryKey: triggerKeys.stats(agentId ?? null),
        queryFn: async ({ signal }) =>
            unwrap(await engineApi.triggers.stats(agentId === undefined ? {} : { agentId }, signal)),
        staleTime: TRIGGER_STALE_MS,
    });
}

/** One page of triggers; the previous page stays on screen while the next one loads. */
export function useTriggers(filters: TriggerListParams) {
    return useQuery({
        ...triggerListQueryOptions(useEngineApi(), filters),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevelFailure,
    });
}

export function useTrigger(triggerId: TriggerId) {
    return useQuery({ ...triggerQueryOptions(useEngineApi(), triggerId), throwOnError: isPageLevelFailure });
}

export function useTriggerFires(triggerId: TriggerId, cursor: string | null) {
    return useQuery({
        ...triggerFiresQueryOptions(useEngineApi(), triggerId, cursor),
        placeholderData: keepPreviousData,
    });
}

export function useTriggerStats(agentId?: AgentId) {
    return useQuery(triggerStatsQueryOptions(useEngineApi(), agentId));
}
