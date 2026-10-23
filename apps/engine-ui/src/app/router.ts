import { prefersReducedMotion } from '@ptbk/ui';
import type { MotionMatchMedia } from '@ptbk/ui';
import { createRouter } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';

import { routeTree } from '../routeTree.gen';
import { RouteError, RouteNotFound, RoutePending } from './route-states';
import type { RouterContext } from './router-context';

export interface AppRouterOptions {
    readonly history?: RouterHistory;
    /** Decides whether route changes animate; under reduced motion they never do. */
    readonly matchMedia?: MotionMatchMedia;
}

/** A fast load shows no skeleton at all; a slow one shows it long enough not to flash. */
export const PENDING_DELAY_MS = 300;
export const PENDING_MIN_MS = 300;

/**
 * Only a change of route animates. Search-param updates (typing in a search box, a filter, the next page) follow each
 * other faster than a transition runs, and a transition the next one skips rejects its `ready` promise, which the
 * router never handles: every quick filter change would surface as an uncaught error.
 */
export const ROUTE_VIEW_TRANSITION = {
    types: ({ pathChanged }: { readonly pathChanged: boolean }) => (pathChanged ? ['route'] : false),
} as const;

export function createAppRouter(context: RouterContext, options: AppRouterOptions = {}) {
    return createRouter({
        routeTree,
        context,
        ...(options.history === undefined ? {} : { history: options.history }),
        defaultPreload: 'intent',
        // TanStack Query alone decides freshness; the router always asks it.
        defaultPreloadStaleTime: 0,
        defaultViewTransition: prefersReducedMotion(options.matchMedia) ? false : ROUTE_VIEW_TRANSITION,
        defaultErrorComponent: RouteError,
        defaultPendingComponent: RoutePending,
        defaultPendingMs: PENDING_DELAY_MS,
        defaultPendingMinMs: PENDING_MIN_MS,
        defaultNotFoundComponent: RouteNotFound,
    });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter;
    }
}
