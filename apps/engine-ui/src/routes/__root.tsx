import { createRootRouteWithContext } from '@tanstack/react-router';

import { RootError } from '../app/route-states';
import type { RouterContext } from '../app/router-context';
import { engineInfoQueryOptions } from '../features/engine/engine-queries';
import { meQueryOptions } from '../features/session/session-queries';
import { AppShell } from '../features/shell/app-shell';

export const Route = createRootRouteWithContext<RouterContext>()({
    // `staleTime: 'static'` is the former `ensureQueryData`: a cached entry resolves at once, and the component's own
    // query refetches it in the background when stale. The shell needs both before it can render.
    loader: ({ context }) =>
        Promise.all([
            context.queryClient.query({ ...engineInfoQueryOptions(context.engineApi), staleTime: 'static' }),
            context.queryClient.query({ ...meQueryOptions(context.engineApi), staleTime: 'static' }),
        ]),
    component: AppShell,
    // Without the engine or the member there is no shell to render into.
    errorComponent: RootError,
});
