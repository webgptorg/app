import { createFileRoute, Outlet } from '@tanstack/react-router';

import { redirectIfSignedIn } from '../../features/session/session-guards';

/** Sign-in and sign-up: someone already signed in goes home instead. */
export const Route = createFileRoute('/_auth/_guest')({
    beforeLoad: ({ context }) => redirectIfSignedIn(context),
    component: Outlet,
});
