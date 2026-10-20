import type { EngineApiClient } from '@ptbk/engine-api';
import type { QueryClient } from '@tanstack/react-query';

/** What route loaders get, so they can prefetch with `queryClient.ensureQueryData` through the injected client. */
export interface RouterContext {
    readonly queryClient: QueryClient;
    readonly engineApi: EngineApiClient;
}
