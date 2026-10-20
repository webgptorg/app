import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';

import type { RouterContext } from '../app/router-context';
import { engineInfoQueryOptions } from '../features/engine/engine-queries';

export const Route = createRootRouteWithContext<RouterContext>()({
    // `staleTime: 'static'` is the former `ensureQueryData`: a cached entry resolves at once, and the component's own
    // query refetches it in the background when stale.
    loader: ({ context }) =>
        context.queryClient.query({ ...engineInfoQueryOptions(context.engineApi), staleTime: 'static' }),
    component: RootLayout,
});

// Placeholder layout; U-02 replaces it with the app shell.
function RootLayout() {
    return (
        <div className="flex min-h-dvh flex-col">
            <header className="border-b border-neutral-200 px-4 py-3">
                <nav aria-label="Main">
                    <Link to="/agents" className="text-blue-700 underline">
                        Agents
                    </Link>
                </nav>
            </header>
            <main className="flex-1 px-4 py-6">
                <Outlet />
            </main>
        </div>
    );
}
