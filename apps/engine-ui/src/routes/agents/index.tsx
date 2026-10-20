import { createFileRoute, stripSearchParams } from '@tanstack/react-router';

import { agentListParams, AgentListSearch, DEFAULT_AGENT_SORT } from '../../features/agents/agent-list-search';
import { AgentsListPage } from '../../features/agents/agents-list-page';
import { agentListQueryOptions } from '../../features/agents/agents-queries';

export const Route = createFileRoute('/agents/')({
    validateSearch: AgentListSearch,
    search: { middlewares: [stripSearchParams({ sort: DEFAULT_AGENT_SORT })] },
    loaderDeps: ({ search }) => agentListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads (keepPreviousData), instead
    // of the router swapping in a pending page. Hover preloading still fills the cache before the click.
    loader: ({ context, deps }) => {
        // A failure shows in the table (with retry) once the component's own query sees it.
        context.queryClient.query(agentListQueryOptions(context.engineApi, deps)).catch(() => undefined);
    },
    component: AgentsListPage,
});
