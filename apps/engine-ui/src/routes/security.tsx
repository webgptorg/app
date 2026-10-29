import { createFileRoute } from '@tanstack/react-router';

import { loadAccess } from '../app/registry/engine-access';
import { requireFeature } from '../app/registry/require-feature';
import { securityOverviewQueryOptions } from '../features/security/security-queries';
import { SecurityPage } from '../features/security/security-page';

export const Route = createFileRoute('/security')({
    beforeLoad: requireFeature('security'),
    // Not awaited: the checklist shows its own skeleton, and a failure shows there with a retry.
    loader: async ({ context }) => {
        if (!(await loadAccess(context)).can('security.read')) return;
        context.queryClient.query(securityOverviewQueryOptions(context.engineApi)).catch(() => undefined);
    },
    component: SecurityPage,
});
