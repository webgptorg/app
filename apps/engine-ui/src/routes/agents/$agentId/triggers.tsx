import { AgentId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../../app/registry/require-feature';
import { AgentTriggersPage } from '../../../features/triggers/agent-triggers-page';
import { triggerListParams, TriggerSearch } from '../../../features/triggers/trigger-search';
import { triggerListQueryOptions } from '../../../features/triggers/triggers-queries';

export const Route = createFileRoute('/agents/$agentId/triggers')({
    beforeLoad: requireFeature('triggers', { agentTab: 'triggers' }),
    validateSearch: TriggerSearch,
    loaderDeps: ({ search }) => ({ search }),
    loader: ({ context, params, deps }) => {
        const agentId = AgentId.safeParse(params.agentId).data;
        if (agentId === undefined) return;
        const query = triggerListQueryOptions(context.engineApi, triggerListParams(deps.search, agentId));
        context.queryClient.query(query).catch(() => undefined);
    },
    component: AgentTriggersPage,
});
