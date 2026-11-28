import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { InboxPage } from '../features/notifications/inbox-page';
import { inboxQueryOptions } from '../features/notifications/notifications-queries';

export const Route = createFileRoute('/inbox')({
    beforeLoad: requireFeature('notifications'),
    // Not awaited: the page shows its own skeleton and error.
    loader: ({ context }) => {
        context.queryClient.infiniteQuery(inboxQueryOptions(context.engineApi)).catch(() => undefined);
    },
    component: InboxPage,
});
