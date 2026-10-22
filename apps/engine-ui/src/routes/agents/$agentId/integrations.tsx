import { AgentId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../../app/registry/require-feature';
import { AgentIntegrationsPage } from '../../../features/integrations/agent-integrations-page';
import { integrationListParams, IntegrationSearch } from '../../../features/integrations/integration-search';
import { integrationListQueryOptions } from '../../../features/integrations/integrations-queries';

export const Route = createFileRoute('/agents/$agentId/integrations')({
    beforeLoad: requireFeature('integrations', { agentTab: 'integrations' }),
    validateSearch: IntegrationSearch,
    loaderDeps: ({ search }) => ({ search }),
    loader: ({ context, params, deps }) => {
        const agentId = AgentId.safeParse(params.agentId).data;
        if (agentId === undefined) return;
        const query = integrationListQueryOptions(context.engineApi, integrationListParams(deps.search, agentId));
        context.queryClient.query(query).catch(() => undefined);
    },
    component: AgentIntegrationsPage,
});
