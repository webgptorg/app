import { createFileRoute } from '@tanstack/react-router';

import { TrustPage } from '../features/trust/trust-page';

/** Public, like `/abuse`: the explanation is for anyone deciding whether to trust us, signed in or not. */
export const Route = createFileRoute('/trust')({
    component: TrustPage,
});
