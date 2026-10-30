import { createFileRoute } from '@tanstack/react-router';

import { loadAccess } from '../app/registry/engine-access';
import { requireFeature } from '../app/registry/require-feature';
import { securityOverviewQueryOptions } from '../features/security/security-queries';
import { SettingsPage } from '../features/settings/settings-page';

export const Route = createFileRoute('/settings')({
    beforeLoad: requireFeature('settings'),
    // The update policy is part of the security overview; not awaited, its card shows a skeleton meanwhile.
    loader: async ({ context }) => {
        if (!(await loadAccess(context)).can('security.read')) return;
        context.queryClient.query(securityOverviewQueryOptions(context.engineApi)).catch(() => undefined);
    },
    component: SettingsPage,
});
