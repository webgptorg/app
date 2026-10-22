import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { EmptyState, RelativeTime, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { runTitle } from '../runs/run-format';
import { RunStatusBadge } from '../runs/run-status';
import { useCurrentMember } from '../session/use-current-member';
import { AgentListWidget } from './agent-list-widget';
import { HomeWidget } from './home-widget';
import { memberAgentsQueryOptions, myRunsQueryOptions, recentChatsQueryOptions } from './home-queries';

/** For everyone who does not oversee the engine: their own running work, the agents they can use, their chats. */
export function MemberHome() {
    const agentsVisible = useAllows({ permission: 'agents.read' });
    const chatsVisible = useAllows({ permission: 'chats.read' });
    const runsVisible = useAllows({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' });
    return (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {runsVisible ? <MyRuns /> : null}
            {agentsVisible ? <MemberAgents /> : null}
            {chatsVisible ? <RecentChats /> : null}
        </div>
    );
}

const rowsSkeleton = (
    <ul className="flex flex-col gap-3">
        {[0, 1, 2].map((row) => (
            <li key={row} className="flex items-center justify-between gap-3">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-5 w-16" />
            </li>
        ))}
    </ul>
);

function MemberAgents() {
    return (
        <AgentListWidget
            title={m.home_my_agents()}
            query={useQuery(memberAgentsQueryOptions(useEngineApi()))}
            skeletonRows={4}
        />
    );
}

function MyRuns() {
    const engineApi = useEngineApi();
    const { memberId } = useCurrentMember();
    return (
        <HomeWidget
            title={m.home_my_runs()}
            query={useQuery(myRunsQueryOptions(engineApi, memberId))}
            skeleton={rowsSkeleton}
        >
            {(page) =>
                page.items.length === 0 ? (
                    <EmptyState title={m.home_my_runs_empty()} headingLevel={3} />
                ) : (
                    <ul className="flex flex-col divide-y divide-divider">
                        {page.items.map((run) => (
                            <li key={run.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
                                <div className="flex min-w-0 flex-col">
                                    <Link to="/runs/$runId" params={{ runId: run.id }} className="truncate">
                                        {runTitle(run)}
                                    </Link>
                                    {run.agentName === null ? null : (
                                        <span className="truncate text-sm text-text-muted">{run.agentName}</span>
                                    )}
                                </div>
                                <RunStatusBadge status={run.status} />
                            </li>
                        ))}
                    </ul>
                )
            }
        </HomeWidget>
    );
}

function RecentChats() {
    return (
        <HomeWidget
            title={m.home_recent_chats()}
            query={useQuery(recentChatsQueryOptions(useEngineApi()))}
            skeleton={rowsSkeleton}
        >
            {(page) =>
                page.items.length === 0 ? (
                    <EmptyState title={m.home_recent_chats_empty()} headingLevel={3} />
                ) : (
                    <ul className="flex flex-col divide-y divide-divider">
                        {page.items.map((chat) => (
                            <li key={chat.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
                                <Link
                                    to="/agents/$agentId/chat/$chatId"
                                    params={{ agentId: chat.agentId, chatId: chat.id }}
                                    className="min-w-0 truncate"
                                >
                                    {chat.title.trim() === '' ? m.chat_untitled() : chat.title}
                                </Link>
                                <RelativeTime
                                    value={new Date(chat.updatedAt)}
                                    className="shrink-0 text-sm text-text-muted"
                                />
                            </li>
                        ))}
                    </ul>
                )
            }
        </HomeWidget>
    );
}
