import type { EngineApiClient } from '@ptbk/engine-api';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

import { EngineApiProvider } from './engine-api-context';
import type { AppRouter } from './router';

export interface AppProvidersProps {
    readonly engineApi: EngineApiClient;
    readonly queryClient: QueryClient;
    readonly router: AppRouter;
}

export function AppProviders({ engineApi, queryClient, router }: AppProvidersProps) {
    return (
        <EngineApiProvider client={engineApi}>
            <QueryClientProvider client={queryClient}>
                <RouterProvider router={router} />
            </QueryClientProvider>
        </EngineApiProvider>
    );
}
