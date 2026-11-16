import { createFileRoute, stripSearchParams } from '@tanstack/react-router';

import {
    agentListGroups,
    agentListParams,
    AgentListSearch,
    builtInAgentParams,
    DEFAULT_AGENT_SORT,
    engineSearch,
} from '../../features/agents/agent-list-search';
import { AgentsListPage } from '../../features/agents/agents-list-page';
import { agentListQueryOptions } from '../../features/agents/agents-queries';

export const Route = createFileRoute('/agents/')({
    validateSearch: AgentListSearch,
    search: { middlewares: [stripSearchParams({ sort: DEFAULT_AGENT_SORT })] },
    loaderDeps: ({ search }) => ({ search: engineSearch(search) }),
    // Not awaited: the table keeps the previous page on screen while the next one loads (keepPreviousData), instead
    // of the router swapping in a pending page. Hover preloading still fills the cache before the click.
    loader: ({ context, deps }) => {
        // A failure shows in the table (with retry) once the component's own query sees it.
        const shown = agentListGroups(deps.search);
        if (shown.own) {
            context.queryClient
                .query(agentListQueryOptions(context.engineApi, agentListParams(deps.search)))
                .catch(() => undefined);
        }
        if (shown.builtIn) {
            context.queryClient
                .query(agentListQueryOptions(context.engineApi, builtInAgentParams(deps.search)))
                .catch(() => undefined);
        }
    },
    component: AgentsListPage,
});
