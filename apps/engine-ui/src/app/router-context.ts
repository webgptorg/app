import type { EngineApiClient } from '@ptbk/engine-api';
import type { QueryClient } from '@tanstack/react-query';

import type { FeatureDefinition } from './registry/feature';

/** What route loaders and guards get: the injected client and query cache, and the registered features. */
export interface RouterContext {
    readonly queryClient: QueryClient;
    readonly engineApi: EngineApiClient;
    /** `FEATURES` in the app; tests pass their own list to exercise the registry. */
    readonly features: readonly FeatureDefinition[];
}
