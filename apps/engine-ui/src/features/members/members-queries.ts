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
