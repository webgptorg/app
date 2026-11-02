import { createFileRoute, redirect } from '@tanstack/react-router';

/** The list moved to `/engines`; this keeps links already in emails and bookmarks working. */
export const Route = createFileRoute('/_app/teams/')({
    beforeLoad: () => {
        throw redirect({ to: '/engines', replace: true });
    },
});
