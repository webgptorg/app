import { KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { Agent } from '@ptbk/engine-api';
import { Card, RelativeTime } from '@ptbk/ui';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
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

function Detail({
    term,
    wide = false,
    children,
}: {
    readonly term: string;
    readonly wide?: boolean;
    readonly children: ReactNode;
}) {
    return (
        <div
            className={wide ? 'flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-3' : 'flex min-w-0 flex-col gap-1'}
        >
            <dt className="text-sm text-text-muted">{term}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

function LastActivity({ agent }: { readonly agent: Agent }) {
    const activity = useQuery(agentLastActivityQueryOptions(useEngineApi(), agent.id));
    if (activity.data === undefined) return <span>{m.agent_value_unknown()}</span>;
    if (activity.data === null) return <span>{m.agent_no_activity()}</span>;
    return <RelativeTime value={new Date(activity.data)} />;
}

/** The model the agent last ran on; runs carry it (`runs@1`), the agent record does not. */
function LatestModel({ agent }: { readonly agent: Agent }) {
    const run = useQuery(agentLatestRunQueryOptions(useEngineApi(), agent.id));
    return <span>{run.data?.model ?? m.agent_value_unknown()}</span>;
}

/** Identity and state of the agent, then every overview card the registry allows, each failing on its own. */
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
        <div className="flex flex-col gap-6">
            <Card title={m.agent_overview_details()}>
                <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <Detail term={m.agent_field_name()}>{agent.profile.fullname || agent.name}</Detail>
                    <Detail term={m.agents_column_status()}>
                        <AgentStatusBadge agentId={agent.id} />
                    </Detail>
                    <Detail term={m.agents_column_visibility()}>
                        <AgentVisibilityBadge visibility={agent.visibility} />
                    </Detail>
                    <Detail term={m.agents_column_created_by()}>
                        <AgentCreator memberId={agent.createdBy} />
                    </Detail>
                    <Detail term={m.agent_field_created()}>
                        <RelativeTime value={new Date(agent.createdAt)} />
                    </Detail>
                    <Detail term={m.agent_field_updated()}>
                        <RelativeTime value={new Date(agent.updatedAt)} />
                    </Detail>
                    <Detail term={m.agents_column_last_activity()}>
                        <LastActivity agent={agent} />
                    </Detail>
                    {showModel ? (
                        <Detail term={m.agent_field_model()}>
                            <LatestModel agent={agent} />
                        </Detail>
                    ) : null}
                    {agent.profile.description === '' ? null : (
                        <Detail term={m.agents_column_description()} wide>
                            <p className="max-w-prose whitespace-pre-line">{agent.profile.description}</p>
                        </Detail>
                    )}
                </dl>
            </Card>
            {cards.map((card) => (
                <OverviewCardBoundary key={card.id}>
                    <card.component agentId={agent.id} />
                </OverviewCardBoundary>
            ))}
        </div>
    );
}
