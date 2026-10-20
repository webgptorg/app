import type { EngineApiClient } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { engineKeys } from './engine-keys';

/** `GET /engine`: name, hostname, dashboard link and mode. Prefetched by the root route. */
export function engineInfoQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: engineKeys.info(),
        queryFn: async ({ signal }) => unwrap(await engineApi.engine.get(signal)),
    });
}
