import { AGENT_SORTS } from '@ptbk/engine-api';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { useEngineApi } from '../../app/engine-api-context';
import { requireFeature } from '../../app/registry/require-feature';
import { agentListQueryOptions } from '../../features/agents/agents-queries';
import { Page } from '../../features/shell/page';
import { m } from '../../paraglide/messages';

// Not strict: a URL may carry parameters this route does not know, and a bad value falls back instead of throwing.
const AgentsSearch = z.object({
    sort: z.enum(AGENT_SORTS).default('name').catch('name'),
});

export const Route = createFileRoute('/agents/')({
    validateSearch: AgentsSearch,
    beforeLoad: requireFeature('agents'),
    loaderDeps: ({ search }) => ({ sort: search.sort }),
    loader: ({ context, deps }) =>
        context.queryClient.query({ ...agentListQueryOptions(context.engineApi, deps), staleTime: 'static' }),
    component: AgentsPage,
});

// Placeholder until U-03 builds the agents list.
function AgentsPage() {
    const { sort } = Route.useSearch();
    const { data } = useSuspenseQuery(agentListQueryOptions(useEngineApi(), { sort }));
    return (
        <Page title={m.agents_title()}>
            <ul className="list-disc ps-6">
                {data.items.map((agent) => (
                    <li key={agent.id}>{agent.name}</li>
                ))}
            </ul>
        </Page>
    );
}
