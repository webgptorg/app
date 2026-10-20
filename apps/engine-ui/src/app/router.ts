import { createRouter } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';

import { routeTree } from '../routeTree.gen';
import { RouteError, RouteNotFound, RoutePending } from './route-placeholders';
import type { RouterContext } from './router-context';

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
    return createRouter({
        routeTree,
        context,
        ...(history === undefined ? {} : { history }),
        defaultPreload: 'intent',
        // TanStack Query alone decides freshness; the router always asks it.
        defaultPreloadStaleTime: 0,
        defaultErrorComponent: RouteError,
        defaultPendingComponent: RoutePending,
        defaultNotFoundComponent: RouteNotFound,
    });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter;
    }
}
