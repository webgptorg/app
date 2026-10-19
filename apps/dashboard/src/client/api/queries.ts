import { queryOptions, useQuery } from '@tanstack/react-query';

import type { RouteContract, RouteResponse } from '../../shared/api/contract';
import { apiRoutes } from '../../shared/api/routes';
import type { ApiClient, ApiOutcome } from './api-client';
import { useApiClient } from './api-client-context';

/** Thrown from query functions so TanStack Query and route error boundaries see every non-ok outcome. */
export class ApiError extends Error {
    readonly outcome: Exclude<ApiOutcome<RouteContract>, { kind: 'ok' }>;

    constructor(outcome: Exclude<ApiOutcome<RouteContract>, { kind: 'ok' }>) {
        super(`API call failed: ${outcome.kind}`);
        this.name = 'ApiError';
        this.outcome = outcome;
    }
}

function dataOrThrow<C extends RouteContract>(outcome: ApiOutcome<C>): RouteResponse<C> {
    if (outcome.kind === 'ok') {
        return outcome.data;
    }
    throw new ApiError(outcome);
}

export function environmentQuery(client: ApiClient) {
    return queryOptions({
        queryKey: ['environment'],
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.getEnvironment, {}, signal)),
        staleTime: Infinity,
    });
}

export function useEnvironment() {
    return useQuery(environmentQuery(useApiClient()));
}
