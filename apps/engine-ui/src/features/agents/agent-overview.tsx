import { KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { Agent } from '@ptbk/engine-api';
import { RelativeTime } from '@ptbk/ui';
import { QueryErrorResetBoundary, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { useEngineCapabilities, useVisibleFeatures } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { AgentCreator } from './agent-creator';
import { useAgentIdParam } from './agent-detail-route';
import { agentDetailQueryOptions, agentLastActivityQueryOptions, agentLatestRunQueryOptions } from './agents-queries';
import { OverviewCardBoundary } from './overview-card-boundary';

function Detail({ term, children }: { readonly term: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 items-baseline gap-1.5">
            <dt className="text-text-muted">{term}</dt>
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

/**
 * A quiet line of facts the header does not show (who made the agent, when, its model), then every overview card the
 * registry allows, each failing on its own. Name, state, visibility and description are the header's.
 */
export function AgentOverview() {
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const { can } = usePermissions();
    const capabilities = useEngineCapabilities();
    const showModel = supports({ capabilities }, KNOWN_CAPABILITIES.runs) && can('runs.read');
    const detailsId = useId();
    const cards = useVisibleFeatures()
        .flatMap((feature) => feature.agentOverviewCards ?? [])
        .toSorted((a, b) => a.order - b.order);

    return (
        <div className="flex flex-col gap-6">
            <section aria-labelledby={detailsId} className="flex flex-col gap-3">
                <h2 id={detailsId} className="sr-only">
                    {m.agent_overview_details()}
                </h2>
                {agent.profile.description === '' ? null : (
                    // The header leaves the description out on phones, so it is here instead.
                    <p className="max-w-prose whitespace-pre-line md:hidden">{agent.profile.description}</p>
                )}
                <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                    {agent.profile.fullname === '' || agent.profile.fullname === agent.name ? null : (
                        <Detail term={m.agent_field_name()}>{agent.profile.fullname}</Detail>
                    )}
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
                </dl>
            </section>
            {cards.map((card) => (
                <QueryErrorResetBoundary key={`${agent.id}:${card.id}`}>
                    {({ reset }) => (
                        <OverviewCardBoundary onReset={reset}>
                            <card.component agentId={agent.id} />
                        </OverviewCardBoundary>
                    )}
                </QueryErrorResetBoundary>
            ))}
        </div>
    );
}
