import type { AgentId, EngineApiClient, IntegrationId } from '@ptbk/engine-api';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { integrationKeys } from './integrations-keys';
import type { IntegrationListParams } from './integrations-keys';

/**
 * Every change on the engine's side arrives as an `integration.changed` event or `integration.*` activity, which
 * invalidates what it touches (`useIntegrationEventSync`), so nothing here goes stale on a timer and nothing polls.
 */
const INTEGRATION_STALE_MS = Number.POSITIVE_INFINITY;
/** The detail page shows the latest activity; the full history belongs to the home feed. */
export const RECENT_ACTIVITY_LIMIT = 20;

/** `GET /integrations`, newest first; every filter and the paging happen on the engine. */
export function integrationListQueryOptions(engineApi: EngineApiClient, params: IntegrationListParams) {
    return queryOptions({
        queryKey: integrationKeys.list(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.integrations.list(params, signal)),
        staleTime: INTEGRATION_STALE_MS,
    });
}

/** `GET /integrations/{integrationId}`. */
export function integrationQueryOptions(engineApi: EngineApiClient, integrationId: IntegrationId) {
    return queryOptions({
        queryKey: integrationKeys.detail(integrationId),
        queryFn: async ({ signal }) => unwrap(await engineApi.integrations.get(integrationId, signal)),
        staleTime: INTEGRATION_STALE_MS,
    });
}

/** `GET /integrations/stats`, for one agent's own integrations or (without `agentId`) the whole engine. */
export function integrationStatsQueryOptions(engineApi: EngineApiClient, agentId?: AgentId) {
    return queryOptions({
        queryKey: integrationKeys.stats(agentId ?? null),
        queryFn: async ({ signal }) =>
            unwrap(await engineApi.integrations.stats(agentId === undefined ? {} : { agentId }, signal)),
        staleTime: INTEGRATION_STALE_MS,
    });
}

/** `GET /activity?integrationId`: the integration's latest activity, newest first. */
export function integrationActivityQueryOptions(engineApi: EngineApiClient, integrationId: IntegrationId) {
    return queryOptions({
        queryKey: integrationKeys.activity(integrationId),
        queryFn: async ({ signal }) =>
            unwrap(await engineApi.activity.list({ integrationId, limit: RECENT_ACTIVITY_LIMIT }, signal)),
        staleTime: INTEGRATION_STALE_MS,
    });
}

/** One page of integrations; the previous page stays on screen while the next one loads. */
export function useIntegrations(params: IntegrationListParams) {
    return useQuery({
        ...integrationListQueryOptions(useEngineApi(), params),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevelFailure,
    });
}

export function useIntegration(integrationId: IntegrationId) {
    return useQuery({ ...integrationQueryOptions(useEngineApi(), integrationId), throwOnError: isPageLevelFailure });
}

export function useIntegrationStats(agentId?: AgentId) {
    return useQuery(integrationStatsQueryOptions(useEngineApi(), agentId));
}
