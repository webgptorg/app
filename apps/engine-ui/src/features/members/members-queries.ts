import type { EngineApiClient, MemberId } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { memberKeys } from './members-keys';
import type { MemberListParams } from './members-keys';

const MEMBER_STALE_MS = 30_000;

/** `GET /members`, by display name; the engine pages, the UI never sorts or filters members itself. */
export function memberListQueryOptions(engineApi: EngineApiClient, params: MemberListParams) {
    return queryOptions({
        queryKey: memberKeys.list(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.members.list(params, signal)),
        staleTime: MEMBER_STALE_MS,
    });
}

/** `GET /members/{id}`, for showing whose a credential is. */
export function memberDetailQueryOptions(engineApi: EngineApiClient, memberId: MemberId) {
    return queryOptions({
        queryKey: memberKeys.detail(memberId),
        queryFn: async ({ signal }) => unwrap(await engineApi.members.get(memberId, signal)),
        staleTime: MEMBER_STALE_MS,
    });
}

/** A page holds every pending invite: they expire, and nobody keeps more open than this. */
export const INVITES_PAGE_SIZE = 100;

/** `GET /invites`, newest first. Draft in the contract: an engine without invites answers 404 `not-found`. */
export function inviteListQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: memberKeys.invites(),
        queryFn: async ({ signal }) =>
            unwrap(await engineApi.members.listInvites({ limit: INVITES_PAGE_SIZE }, signal)),
        staleTime: MEMBER_STALE_MS,
    });
}

/** The engine keeps at most 20 pending requests (`MAX_PENDING_ACCESS_REQUESTS`), so one page holds them all. */
export const ACCESS_REQUESTS_PAGE_SIZE = 50;
/**
 * No event announces a new request, so the list is refreshed while the page is visible; TanStack Query pauses the
 * interval in a hidden tab.
 */
export const ACCESS_REQUESTS_REFRESH_MS = 30_000;

/** `GET /access-requests` (`access-requests@1`), oldest first. */
export function accessRequestListQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: memberKeys.accessRequests(),
        queryFn: async ({ signal }) =>
            unwrap(await engineApi.members.listAccessRequests({ limit: ACCESS_REQUESTS_PAGE_SIZE }, signal)),
        staleTime: MEMBER_STALE_MS,
        refetchInterval: ACCESS_REQUESTS_REFRESH_MS,
    });
}
