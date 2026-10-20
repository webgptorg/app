import { AGENT_SORTS } from '@ptbk/engine-api';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { useEngineApi } from '../../app/engine-api-context';
import { agentListQueryOptions } from '../../features/agents/agents-queries';

// Not strict: a URL may carry parameters this route does not know, and a bad value falls back instead of throwing.
const AgentsSearch = z.object({
    sort: z.enum(AGENT_SORTS).default('name').catch('name'),
});

export const Route = createFileRoute('/agents/')({
    validateSearch: AgentsSearch,
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
        <section aria-labelledby="agents-title" className="space-y-4">
            <h1 id="agents-title" className="text-2xl font-semibold">
                Agents
            </h1>
            <ul className="list-disc pl-6">
                {data.items.map((agent) => (
                    <li key={agent.id}>{agent.name}</li>
                ))}
            </ul>
        </section>
    );
}
