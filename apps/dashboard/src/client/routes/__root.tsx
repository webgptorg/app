import { createRootRouteWithContext, lazyRouteComponent, Outlet } from '@tanstack/react-router';

import { RootError } from '../core/route-states';
import type { RouterContext } from '../core/router-context';

export const Route = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
    errorComponent: RootError,
    // Lazy: the root is never code-split, and the not-found page brings both frames into the entry otherwise.
    notFoundComponent: lazyRouteComponent(() => import('../features/shell/not-found-page'), 'NotFoundPage'),
});
