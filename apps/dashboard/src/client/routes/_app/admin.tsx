import { createFileRoute } from '@tanstack/react-router';

import { requirePlatformAdmin } from '../../features/session/session-guards';

/** Guards every admin page; without a component the route renders its child. */
export const Route = createFileRoute('/_app/admin')({
    beforeLoad: ({ context }) => {
        requirePlatformAdmin(context.session);
    },
});
