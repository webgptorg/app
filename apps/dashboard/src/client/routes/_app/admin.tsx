import { createFileRoute } from '@tanstack/react-router';

import { AdminPage } from '../../features/admin/admin-page';
import { requirePlatformAdmin } from '../../features/session/session-guards';

export const Route = createFileRoute('/_app/admin')({
    beforeLoad: ({ context }) => {
        requirePlatformAdmin(context.session);
    },
    component: AdminPage,
});
