import { createFileRoute } from '@tanstack/react-router';

import { LinkPage } from '../features/link/link-page';

/** Public, like `/abuse`: whoever opens a link URL in a browser is told to give it to the engine instead. */
export const Route = createFileRoute('/link')({
    component: LinkPage,
});
