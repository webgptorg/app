import { createRouter } from '@tanstack/react-router';

import type { RouterContext } from './routes/__root';
import { routeTree } from './routeTree.gen';

export function createAppRouter(context: RouterContext) {
    return createRouter({ routeTree, context, defaultPreload: 'intent', defaultPreloadStaleTime: 0 });
}

declare module '@tanstack/react-router' {
    interface Register {
        router: ReturnType<typeof createAppRouter>;
    }
}
