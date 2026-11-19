import { createRootRouteWithContext, redirect } from '@tanstack/react-router';

import { RootError } from '../app/route-states';
import type { RouterContext } from '../app/router-context';
import { engineInfoQueryOptions } from '../features/engine/engine-queries';
import { loadSetupOnly } from '../features/onboarding/setup-only';
import { meQueryOptions } from '../features/session/session-queries';
import { AppShell } from '../features/shell/app-shell';

export const Route = createRootRouteWithContext<RouterContext>()({
    // An engine paired before it has a project has only its setup to offer; any other page would be empty.
    beforeLoad: async ({ context, location }) => {
        if (location.pathname === '/onboarding') return;
        if (await loadSetupOnly(context)) redirect({ to: '/onboarding', throw: true });
    },
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
