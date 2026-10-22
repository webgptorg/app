import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { integrationListParams, IntegrationSearch } from '../../features/integrations/integration-search';
import { IntegrationsPage } from '../../features/integrations/integrations-page';
import { integrationListQueryOptions } from '../../features/integrations/integrations-queries';

export const Route = createFileRoute('/integrations/')({
    beforeLoad: requireFeature('integrations'),
    validateSearch: IntegrationSearch,
    loaderDeps: ({ search }) => integrationListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads, and shows its own error.
    loader: ({ context, deps }) => {
        context.queryClient.query(integrationListQueryOptions(context.engineApi, deps)).catch(() => undefined);
    },
    component: IntegrationsPage,
});
