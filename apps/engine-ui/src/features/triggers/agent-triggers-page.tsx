import { AgentId } from '@ptbk/engine-api';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';

import type { TriggerSearch } from './trigger-search';
import { NewTriggerLink } from './triggers-page';
import { TriggersTable } from './triggers-table';

const route = getRouteApi('/agents/$agentId/triggers');

/** The agent's Triggers tab: the same list, scoped to the agent by its path. */
export function AgentTriggersPage() {
    const agentId = AgentId.parse(route.useParams().agentId);
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const onSearchChange = useCallback(
        (change: Partial<TriggerSearch>, options: { readonly replace?: boolean } = {}) => {
            void navigate({ search: (previous) => ({ ...previous, ...change }), replace: options.replace ?? false });
        },
        [navigate],
    );
    return (
        <div className="flex flex-col gap-4">
            <div className="flex justify-end">
                <NewTriggerLink agentId={agentId} />
            </div>
            <TriggersTable search={search} onSearchChange={onSearchChange} agentId={agentId} />
        </div>
    );
}
