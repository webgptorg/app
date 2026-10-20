import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';

import { RootError, RouteNotFound } from '../core/route-states';
import type { RouterContext } from '../core/router-context';

export const Route = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
    errorComponent: RootError,
    // An unknown URL matches neither layout, so it gets a bare frame: it cannot know whether someone is signed in.
    notFoundComponent: () => (
        <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center bg-surface px-4 text-text">
            <RouteNotFound />
        </main>
    ),
});
