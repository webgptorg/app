import { AgentId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../../app/registry/require-feature';
import { AgentRunsPage } from '../../../features/runs/agent-runs-page';
import { runListParams, RunSearch } from '../../../features/runs/run-search';
import { runListQueryOptions } from '../../../features/runs/runs-queries';

export const Route = createFileRoute('/agents/$agentId/runs')({
    beforeLoad: requireFeature('runs', { agentTab: 'runs' }),
    validateSearch: RunSearch,
    loaderDeps: ({ search }) => ({ search }),
    loader: ({ context, params, deps }) => {
        const agentId = AgentId.safeParse(params.agentId).data;
        if (agentId === undefined) return;
        const query = runListQueryOptions(context.engineApi, runListParams(deps.search, agentId));
        context.queryClient.query(query).catch(() => undefined);
    },
    component: AgentRunsPage,
});
