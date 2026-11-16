import { KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { Agent } from '@ptbk/engine-api';
import { RelativeTime, Section } from '@ptbk/ui';
import { QueryErrorResetBoundary, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { useEngineCapabilities, useVisibleFeatures } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { AgentStatusBadge, AgentVisibilityBadge } from './agent-badges';
import { AgentCreator } from './agent-creator';
import { useAgentIdParam } from './agent-detail-route';
import { agentDetailQueryOptions, agentLastActivityQueryOptions, agentLatestRunQueryOptions } from './agents-queries';
import { OverviewCardBoundary } from './overview-card-boundary';

function Property({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="grid grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-x-6 py-1.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
            <dt className="text-sm text-text-subtle">{label}</dt>
            <dd className="min-w-0 text-sm break-words">{children}</dd>
        </div>
    );
}

function LastActivity({ agent }: { readonly agent: Agent }) {
    const activity = useQuery(agentLastActivityQueryOptions(useEngineApi(), agent.id));
    if (activity.data === undefined) return <span className="text-text-muted">{m.agent_value_unknown()}</span>;
    if (activity.data === null) return <span className="text-text-muted">{m.agent_no_activity()}</span>;
    return <RelativeTime value={new Date(activity.data)} className="tabular-nums" />;
}

/** The model the agent last ran on; runs carry it (`runs@1`), the agent record does not. */
function LatestModel({ agent }: { readonly agent: Agent }) {
    const run = useQuery(agentLatestRunQueryOptions(useEngineApi(), agent.id));
    // A model ID is an identifier, so it is the one value here in mono.
    if (run.data?.model == null) return <span className="text-text-muted">{m.agent_value_unknown()}</span>;
    return <span className="font-mono text-xs">{run.data.model}</span>;
}

/**
 * What the agent is doing and has done, as the sections the registry allows (chats, tasks, runs, knowledge, triggers,
 * integrations), each failing on its own and leaving the page when it has nothing to show; then its details.
 */
export function AgentOverview() {
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const { can } = usePermissions();
    const capabilities = useEngineCapabilities();
    const showModel = supports({ capabilities }, KNOWN_CAPABILITIES.runs) && can('runs.read');
    const cards = useVisibleFeatures()
        .flatMap((feature) => feature.agentOverviewCards ?? [])
        .toSorted((a, b) => a.order - b.order);

    return (
        // The tabs' line already separates the first section from the header.
        <div className="flex flex-col gap-6 [&>*:first-child]:border-t-0 [&>*:first-child]:pt-1">
            {cards.map((card) => (
                <QueryErrorResetBoundary key={`${agent.id}:${card.id}`}>
                    {({ reset }) => (
                        <OverviewCardBoundary onReset={reset}>
                            <card.component agentId={agent.id} />
                        </OverviewCardBoundary>
                    )}
                </QueryErrorResetBoundary>
            ))}
            <Section title={m.agent_overview_details()}>
                <dl className="flex max-w-2xl flex-col">
                    {agent.profile.fullname === '' || agent.profile.fullname === agent.name ? null : (
                        <Property label={m.agent_field_name()}>{agent.profile.fullname}</Property>
                    )}
                    <Property label={m.agents_column_status()}>
                        <AgentStatusBadge agentId={agent.id} variant="quiet" />
                    </Property>
                    <Property label={m.agents_column_visibility()}>
                        <AgentVisibilityBadge visibility={agent.visibility} />
                    </Property>
                    <Property label={m.agents_column_created_by()}>
                        {agent.origin === 'content' ? (
                            <AgentCreator memberId={agent.createdBy} />
                        ) : (
                            <span className="text-text-muted">{m.agent_created_by_engine()}</span>
                        )}
                    </Property>
                    <Property label={m.agent_field_created()}>
                        <RelativeTime value={new Date(agent.createdAt)} className="tabular-nums" />
                    </Property>
                    <Property label={m.agent_field_updated()}>
                        <RelativeTime value={new Date(agent.updatedAt)} className="tabular-nums" />
                    </Property>
                    <Property label={m.agents_column_last_activity()}>
                        <LastActivity agent={agent} />
                    </Property>
                    {showModel ? (
                        <Property label={m.agent_field_model()}>
                            <LatestModel agent={agent} />
                        </Property>
                    ) : null}
                    {agent.profile.description === '' ? null : (
                        <Property label={m.agents_column_role()}>
                            <span className="whitespace-pre-line">{agent.profile.description}</span>
                        </Property>
                    )}
                </dl>
            </Section>
        </div>
    );
}
