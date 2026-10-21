import type { EngineApiClient } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { securityKeys } from './security-keys';
import type { PasskeyListParams } from './security-keys';

/** Relay states and round trips move on their own, so the open panel refreshes on this interval while visible. */
export const SECURITY_REFRESH_MS = 10_000;

/** A session lists at most this many credentials; nobody has more passkeys or open sessions than a page holds. */
export const CREDENTIALS_PAGE_SIZE = 100;

/** `GET /security`: the engine's own values, shown verbatim. */
export function securityOverviewQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: securityKeys.overview(),
        queryFn: async ({ signal }) => unwrap(await engineApi.security.get(signal)),
        staleTime: SECURITY_REFRESH_MS,
    });
}

/** `GET /me/passkeys`: the signed-in member's own passkeys, newest first. */
export function myPasskeysQueryOptions(engineApi: EngineApiClient, params: PasskeyListParams) {
    return queryOptions({
        queryKey: securityKeys.myPasskeys(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.me.listPasskeys(params, signal)),
    });
}

/** `GET /passkeys`: every member's passkeys, for members who may revoke them (`members.manage`). */
export function allPasskeysQueryOptions(engineApi: EngineApiClient, params: PasskeyListParams) {
    return queryOptions({
        queryKey: securityKeys.allPasskeys(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.passkeys.list(params, signal)),
    });
}

/** `GET /me/sessions`, read for the current session's `passkeyId`: revoking that passkey signs this browser out. */
export function mySessionsQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: securityKeys.mySessions(),
        queryFn: async ({ signal }) =>
            unwrap(await engineApi.me.listSessions({ limit: CREDENTIALS_PAGE_SIZE }, signal)),
    });
}
