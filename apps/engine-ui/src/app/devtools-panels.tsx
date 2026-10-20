import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import type { QueryClient } from '@tanstack/react-query';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';

import type { AppRouter } from './router';

/** Dev server only: the devtools inject `<style>` elements, which the engine's CSP refuses. */
export function DevtoolsPanels({
    router,
    queryClient,
}: {
    readonly router: AppRouter;
    readonly queryClient: QueryClient;
}) {
    return (
        <>
            <TanStackRouterDevtools router={router} />
            <ReactQueryDevtools client={queryClient} />
        </>
    );
}
