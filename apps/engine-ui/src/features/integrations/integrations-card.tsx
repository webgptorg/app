import type { AgentId, ReadIntegration } from '@ptbk/engine-api';
import { STATUS_TINT_CLASSES } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Plug, TriangleAlert } from 'lucide-react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import {
    OverviewFailed,
    OverviewLoading,
    OverviewRow,
    OverviewRows,
    OverviewSection,
    overviewLinkClassName,
} from '../agents/overview-parts';
import { EntityChip } from '../entities/entity-chip';
import { integrationListParams } from './integration-search';
import { IntegrationStatusBadge, needsAttention } from './integration-status';
import { integrationListQueryOptions } from './integrations-queries';

const SHOWN = 10;

/**
 * The agent overview's integrations: what the agent may use, its own and the engine-wide ones, with the ones that need
 * attention or failed first and called out on a soft surface, so an owner sees at a glance what to fix. An agent that
 * uses none has no section.
 */
export function IntegrationsCard({ agentId }: { readonly agentId: AgentId }) {
    const params = { ...integrationListParams({}, agentId), limit: SHOWN };
    const integrations = useQuery(integrationListQueryOptions(useEngineApi(), params));
    const items = integrations.data?.items ?? [];
    if (integrations.isSuccess && items.length === 0) return null;
    const attention = items.filter(({ status }) => needsAttention(status));
    const ordered = [...attention, ...items.filter(({ status }) => !needsAttention(status))];
    return (
        <OverviewSection
            title={m.integrations_card_title()}
            all={
                <Link
                    to="/agents/$agentId/integrations"
                    params={{ agentId }}
                    variant="standalone"
                    className={overviewLinkClassName}
                >
                    {m.integrations_card_all()}
                </Link>
            }
        >
            {integrations.isPending ? (
                <OverviewLoading label={m.integrations_card_title()} />
            ) : integrations.isError ? (
                <OverviewFailed
                    message={m.integrations_load_failed()}
                    onRetry={() => {
                        void integrations.refetch();
                    }}
                    retrying={integrations.isFetching}
                />
            ) : (
                <>
                    {attention.length === 0 ? null : (
                        <p
                            className={cx(
                                'soft-surface flex items-center gap-2 px-3 py-2 text-sm',
                                STATUS_TINT_CLASSES.warning,
                            )}
                        >
                            <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
                            {m.integrations_card_attention({ count: attention.length })}
                        </p>
                    )}
                    <OverviewRows>
                        {ordered.map((integration) => (
                            <IntegrationRow key={integration.id} integration={integration} />
                        ))}
                    </OverviewRows>
                </>
            )}
        </OverviewSection>
    );
}

function IntegrationRow({ integration }: { readonly integration: ReadIntegration }) {
    return (
        <OverviewRow lead={<Plug aria-hidden />} end={integration.agentId === null ? m.integration_all_agents() : null}>
            <EntityChip kind="integration" id={integration.id} name={integration.name} />
            <IntegrationStatusBadge status={integration.status} />
        </OverviewRow>
    );
}
