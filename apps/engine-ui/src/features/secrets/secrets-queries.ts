import type { EngineApiClient } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { secretKeys } from './secrets-keys';
import type { SecretListParams } from './secrets-keys';

const SECRET_STALE_MS = 30_000;

/** `GET /secrets`: metadata only. Search, filters, sort and paging all happen on the engine. */
export function secretListQueryOptions(engineApi: EngineApiClient, params: SecretListParams) {
    return queryOptions({
        queryKey: secretKeys.list(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.secrets.list(params, signal)),
        staleTime: SECRET_STALE_MS,
    });
}
