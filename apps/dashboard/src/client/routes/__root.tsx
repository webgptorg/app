import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';

import { RootError } from '../core/route-states';
import type { RouterContext } from '../core/router-context';
import { NotFoundPage } from '../features/shell/not-found-page';

export const Route = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
    errorComponent: RootError,
    notFoundComponent: NotFoundPage,
});
