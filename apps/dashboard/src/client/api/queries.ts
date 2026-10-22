import { MutationCache, QueryCache, QueryClient, queryOptions, useQuery } from '@tanstack/react-query';

import type { RouteContract, RouteResponse } from '../../shared/api/contract';
import type { CommonProblemCode } from '../../shared/api/problem';
import { apiRoutes } from '../../shared/api/routes';
import type { SessionView } from '../../shared/api/routes';
import type { ApiClient, ApiOutcome } from './api-client';
import { useApiClient } from './api-client-context';

export type ApiFailure = Exclude<ApiOutcome<RouteContract>, { kind: 'ok' }>;

/** Thrown from query and mutation functions so TanStack Query and route error boundaries see every non-ok outcome. */
export class ApiError extends Error {
    readonly outcome: ApiFailure;

    constructor(outcome: ApiFailure) {
        super(`API call failed: ${outcome.kind}`);
        this.name = 'ApiError';
        this.outcome = outcome;
    }
}

export function dataOrThrow<C extends RouteContract>(outcome: ApiOutcome<C>): RouteResponse<C> {
    if (outcome.kind === 'ok') {
        return outcome.data;
    }
    throw new ApiError(outcome);
}

/** The problem code of a failed call, or `null` for anything that is not a declared problem. */
export function problemCode(error: unknown): string | null {
    return error instanceof ApiError && error.outcome.kind === 'problem' ? error.outcome.code : null;
}

export function hasProblem(error: unknown, code: CommonProblemCode): boolean {
    return problemCode(error) === code;
}

const MAX_QUERY_RETRIES = 2;

/** No retry on 4xx or contract breaches (they would fail the same way); at most two on network errors and 5xx. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
    if (failureCount >= MAX_QUERY_RETRIES || !(error instanceof ApiError)) {
        return false;
    }
    const { outcome } = error;
    switch (outcome.kind) {
        case 'network-error':
            return true;
        case 'problem':
        case 'invalid-response':
            return outcome.status >= 500;
    }
}

export const queryKeys = {
    environment: ['environment'] as const,
    session: ['session'] as const,
    passkeys: ['passkeys'] as const,
    sessions: ['sessions'] as const,
    billing: ['billing'] as const,
    adminBilling: ['admin', 'billing'] as const,
    engines: ['engines'] as const,
    engine: (engineId: string) => ['engines', engineId] as const,
    devEmails: ['dev', 'emails'] as const,
};

/** A 401 on any signed-in call means the session ended elsewhere (expired, revoked, signed out everywhere). */
export function createAppQueryClient(deps: { readonly onUnauthenticated: () => void }): QueryClient {
    const onError = (error: unknown): void => {
        if (hasProblem(error, 'unauthorized')) {
            deps.onUnauthenticated();
        }
    };
    return new QueryClient({
        queryCache: new QueryCache({ onError }),
        mutationCache: new MutationCache({ onError }),
        defaultOptions: { queries: { retry: shouldRetryQuery } },
    });
}

export function environmentQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.environment,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.getEnvironment, {}, signal)),
        staleTime: Infinity,
    });
}

/** The fake email adapter's outbox (dev only); a `not-found` problem means the dashboard runs another adapter. */
export function devEmailsQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.devEmails,
        queryFn: async ({ signal }) =>
            dataOrThrow(await client.call(apiRoutes.devEmails, { query: {} }, signal)).emails,
    });
}

export function useEnvironment() {
    return useQuery(environmentQuery(useApiClient()));
}

const SESSION_STALE_MS = 30_000;

/** The signed-in session, or `null` when there is none: signed out is an answer here, not an error. */
export function sessionQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.session,
        queryFn: async ({ signal }): Promise<SessionView | null> => {
            const outcome = await client.call(apiRoutes.getSession, {}, signal);
            if (outcome.kind === 'problem' && outcome.code === 'unauthorized') {
                return null;
            }
            return dataOrThrow(outcome);
        },
        staleTime: SESSION_STALE_MS,
    });
}

export function passkeysQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.passkeys,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.listPasskeys, {}, signal)).passkeys,
    });
}

export function sessionsQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.sessions,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.listSessions, {}, signal)).sessions,
    });
}

/** The active org's billing state, entitlements and the plans Checkout offers. */
export function billingQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.billing,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.getBilling, {}, signal)),
    });
}

export function adminBillingQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.adminBilling,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.adminBilling, {}, signal)).organizations,
    });
}

/** Engine status comes from heartbeats every minute; the list follows while it is on screen, never in the background. */
export const ENGINE_REFETCH_MS = 60_000;

/** The active organization's engines with their live status (D-06). */
export function enginesQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.engines,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.listEngines, {}, signal)).engines,
        refetchInterval: ENGINE_REFETCH_MS,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
    });
}

export function engineQuery(client: ApiClient, engineId: string) {
    return queryOptions({
        queryKey: queryKeys.engine(engineId),
        queryFn: async ({ signal }) =>
            dataOrThrow(await client.call(apiRoutes.getEngine, { params: { engineId } }, signal)).engine,
        refetchInterval: ENGINE_REFETCH_MS,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
    });
}
