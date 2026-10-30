import type { AgentId, ReadIntegration } from '@ptbk/engine-api';
import { Card, ErrorState, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { integrationListParams } from './integration-search';
import { IntegrationStatusBadge, needsAttention } from './integration-status';
import { integrationListQueryOptions } from './integrations-queries';

const SHOWN = 10;

/**
 * The agent overview's card: what the agent may use, its own and the engine-wide integrations, with the ones that need
 * attention or failed first, so an owner sees at a glance what to fix or switch off. An agent that uses none shows no
 * card: the Integrations tab is one click away, and an empty card would only add noise to a new agent's overview.
 */
export function IntegrationsCard({ agentId }: { readonly agentId: AgentId }) {
    const params = { ...integrationListParams({}, agentId), limit: SHOWN };
    const integrations = useQuery(integrationListQueryOptions(useEngineApi(), params));
    const items = integrations.data?.items ?? [];
    const attention = items.filter(({ status }) => needsAttention(status));
    const ordered = [...attention, ...items.filter(({ status }) => !needsAttention(status))];
    if (integrations.isSuccess && ordered.length === 0) return null;
    return (
        <Card
            title={m.integrations_card_title()}
            actions={
                <Link to="/agents/$agentId/integrations" params={{ agentId }}>
                    {m.integrations_card_all()}
                </Link>
            }
        >
            {integrations.isPending ? (
                <ul aria-busy="true" aria-label={m.integrations_card_title()} className="flex flex-col gap-2">
                    {Array.from({ length: 3 }, (_, index) => (
                        <li key={index}>
                            <Skeleton shape="text" className="h-6 w-full" />
                        </li>
                    ))}
                </ul>
            ) : integrations.isError ? (
                <ErrorState
                    message={m.integrations_load_failed()}
                    onRetry={() => {
                        void integrations.refetch();
                    }}
                    retrying={integrations.isFetching}
                />
            ) : (
                <ul className="flex flex-col divide-y divide-divider">
                    {ordered.map((integration) => (
                        <CardRow key={integration.id} integration={integration} />
                    ))}
                </ul>
            )}
        </Card>
    );
}

function CardRow({ integration }: { readonly integration: ReadIntegration }) {
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <IntegrationStatusBadge status={integration.status} />
            <Link
                to="/integrations/$integrationId"
                params={{ integrationId: integration.id }}
                className="min-w-0 flex-1 break-words"
            >
                {integration.name}
            </Link>
            {integration.agentId === null ? (
                <span className="text-sm text-text-muted">{m.integration_all_agents()}</span>
            ) : null}
        </li>
    );
}
