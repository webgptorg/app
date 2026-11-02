import { createFileRoute, redirect } from '@tanstack/react-router';

/** The engine list is the signed-in landing page; `/` stays the address sign-in and "back to the start" use. */
export const Route = createFileRoute('/_app/')({
    beforeLoad: () => {
        throw redirect({ to: '/engines', replace: true });
    },
});
