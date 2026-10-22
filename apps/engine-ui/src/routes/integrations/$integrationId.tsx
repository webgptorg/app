import { IntegrationId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { IntegrationDetailPage } from '../../features/integrations/integration-detail-page';
import { integrationQueryOptions } from '../../features/integrations/integrations-queries';

export const Route = createFileRoute('/integrations/$integrationId')({
    beforeLoad: requireFeature('integrations'),
    // Not awaited: the page shows its own skeleton, not-found and retry states.
    loader: ({ context, params }) => {
        const integrationId = IntegrationId.safeParse(params.integrationId).data;
        if (integrationId === undefined) return;
        context.queryClient.query(integrationQueryOptions(context.engineApi, integrationId)).catch(() => undefined);
    },
    component: IntegrationDetailPage,
});
