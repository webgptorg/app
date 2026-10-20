import type { EngineApiClient } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { sessionKeys } from './session-keys';

/** `GET /me`: the signed-in member, their organization, role label and permissions. Prefetched by the root route. */
export function meQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: sessionKeys.me(),
        queryFn: async ({ signal }) => unwrap(await engineApi.me.get(signal)),
        // Permissions change rarely and the engine enforces them anyway; the UI only hides what would be refused.
        staleTime: 60_000,
    });
}
