import { AgentId } from '@ptbk/engine-api';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';

import { m } from '../../paraglide/messages';
import { AddIntegrationActions } from './add-integration-actions';
import type { IntegrationSearch } from './integration-search';
import { IntegrationsTable } from './integrations-table';

const route = getRouteApi('/agents/$agentId/integrations');

/** The agent's Integrations tab: what this agent may use, its own integrations and the engine-wide ones. */
export function AgentIntegrationsPage() {
    const agentId = AgentId.parse(route.useParams().agentId);
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const onSearchChange = useCallback(
        (change: Partial<IntegrationSearch>, options: { readonly replace?: boolean } = {}) => {
            void navigate({ search: (previous) => ({ ...previous, ...change }), replace: options.replace ?? false });
        },
        [navigate],
    );
    return (
        <div className="flex flex-col gap-3">
            <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
                <p className="max-w-prose text-sm text-text-muted">{m.integrations_agent_intro()}</p>
                <AddIntegrationActions agentId={agentId} />
            </div>
            <IntegrationsTable search={search} onSearchChange={onSearchChange} agentId={agentId} />
        </div>
    );
}
