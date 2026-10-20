import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { isUnauthenticated, shouldRetryQuery } from './api-errors';

export interface QueryClientDeps {
    /** Called when the engine says the session is gone; engine-ui never renders a sign-in form itself. */
    readonly onUnauthenticated: () => void;
}

export function createAppQueryClient(deps: QueryClientDeps): QueryClient {
    const onError = (error: unknown): void => {
        if (isUnauthenticated(error)) deps.onUnauthenticated();
    };
    return new QueryClient({
        queryCache: new QueryCache({ onError }),
        mutationCache: new MutationCache({ onError }),
        defaultOptions: {
            queries: { retry: shouldRetryQuery, refetchOnWindowFocus: true },
        },
    });
}
