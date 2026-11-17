import { createFileRoute, redirect } from '@tanstack/react-router';

import { safeReturnTo } from '../../../features/session/return-to';

/** The old sign-in address, kept for bookmarks and older emails: Continue signs in now. */
export const Route = createFileRoute('/_auth/_guest/signin')({
    beforeLoad: ({ search }) => {
        const returnTo = safeReturnTo((search as Readonly<Record<string, unknown>>)['returnTo']);
        throw redirect({ to: '/continue', search: returnTo === undefined ? {} : { returnTo }, replace: true });
    },
});
