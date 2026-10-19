import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';

import { m } from '../../paraglide/messages';
import type { ApiClient } from '../api/api-client';
import { AppShell } from '../features/shell/app-shell';

export interface RouterContext {
    readonly queryClient: QueryClient;
    readonly apiClient: ApiClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
    component: () => (
        <AppShell>
            <Outlet />
        </AppShell>
    ),
    notFoundComponent: () => (
        <section className="space-y-4">
            <h1 className="text-2xl font-semibold">{m.not_found_title()}</h1>
            <Link to="/" className="text-blue-700 underline">
                {m.not_found_back()}
            </Link>
        </section>
    ),
    errorComponent: ({ reset }) => (
        <section className="space-y-4" role="alert">
            <h1 className="text-2xl font-semibold">{m.error_title()}</h1>
            <button type="button" className="rounded bg-neutral-900 px-3 py-1.5 text-white" onClick={reset}>
                {m.error_retry()}
            </button>
        </section>
    ),
});
