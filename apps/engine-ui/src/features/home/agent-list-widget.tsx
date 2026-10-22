import type { Agent, Page } from '@ptbk/engine-api';
import { EmptyState, Skeleton } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { Bot, Plus } from 'lucide-react';

import { ButtonLink, Link } from '../../app/link';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { AgentStatusBadge } from '../agents/agent-badges';
import { usePermissions } from '../session/use-permissions';
import { HomeWidget } from './home-widget';

export interface AgentListWidgetProps {
    readonly title: string;
    readonly query: UseQueryResult<Page<Agent>>;
    readonly skeletonRows: number;
}

/** Agents with their picture, and their live state where a feature derives it (runs); empty, an invitation to create. */
export function AgentListWidget({ title, query, skeletonRows }: AgentListWidgetProps) {
    const { can } = usePermissions();
    const liveState = useVisibleFeatures().some((feature) => feature.agentStatusProvider !== undefined);
    return (
        <HomeWidget
            title={title}
            query={query}
            skeleton={
                <ul className="flex flex-col gap-3">
                    {Array.from({ length: skeletonRows }, (_, row) => (
                        <li key={row} className="flex items-center gap-3">
                            <Skeleton shape="circle" className="size-8" />
                            <Skeleton className="h-4 w-40" />
                        </li>
                    ))}
                </ul>
            }
            actions={
                <Link to="/agents" className="text-sm">
                    {m.home_all_agents()}
                </Link>
            }
        >
            {(page) =>
                page.items.length === 0 ? (
                    <EmptyState
                        icon={<Bot />}
                        title={m.home_no_agents()}
                        description={m.home_no_agents_body()}
                        headingLevel={3}
                        {...(can('agents.write')
                            ? {
                                  action: (
                                      <ButtonLink to="/agents/new" variant="primary">
                                          <Plus aria-hidden className="size-4" />
                                          {m.agents_new()}
                                      </ButtonLink>
                                  ),
                              }
                            : {})}
                    />
                ) : (
                    <ul className="flex flex-col divide-y divide-divider">
                        {page.items.map((agent) => (
                            <li key={agent.id} className="flex min-h-12 items-center gap-3 py-2">
                                <AgentAvatar name={agent.name} profile={agent.profile} />
                                <div className="flex min-w-0 flex-1 flex-col">
                                    <Link
                                        to="/agents/$agentId"
                                        params={{ agentId: agent.id }}
                                        className="truncate font-medium"
                                    >
                                        {agent.name}
                                    </Link>
                                    {agent.profile.description === '' ? null : (
                                        <span className="truncate text-sm text-text-muted">
                                            {agent.profile.description}
                                        </span>
                                    )}
                                </div>
                                {liveState ? <AgentStatusBadge agentId={agent.id} /> : null}
                            </li>
                        ))}
                    </ul>
                )
            }
        </HomeWidget>
    );
}
