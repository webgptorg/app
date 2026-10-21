import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { securityOverviewQueryOptions } from '../features/security/security-queries';
import { SecurityPage } from '../features/security/security-page';

export const Route = createFileRoute('/security')({
    beforeLoad: requireFeature('security'),
    // Not awaited: each section shows its own skeleton, and a failure shows in the sections with a retry.
    loader: ({ context }) => {
        context.queryClient.query(securityOverviewQueryOptions(context.engineApi)).catch(() => undefined);
    },
    component: SecurityPage,
});
