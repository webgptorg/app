import { AgentId } from '@ptbk/engine-api';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';

import type { RunSearch } from './run-search';
import { RunsTable } from './runs-table';

const route = getRouteApi('/agents/$agentId/runs');

/** The agent's Runs tab: the same timeline, scoped to the agent by its path. */
export function AgentRunsPage() {
    const { agentId } = route.useParams();
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const onSearchChange = useCallback(
        (change: Partial<RunSearch>, options: { readonly replace?: boolean } = {}) => {
            void navigate({ search: (previous) => ({ ...previous, ...change }), replace: options.replace ?? false });
        },
        [navigate],
    );
    return <RunsTable search={search} onSearchChange={onSearchChange} agentId={AgentId.parse(agentId)} />;
}
