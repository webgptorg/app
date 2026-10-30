import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { EmptyState, RelativeTime, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink, Link } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { chatName } from '../chat/chat-source';
import { runTitle } from '../runs/run-format';
import { RunStatusBadge } from '../runs/run-status';
import { useCurrentMember } from '../session/use-current-member';
import { AgentListWidget } from './agent-list-widget';
import { HomeWidget } from './home-widget';
import { memberAgentsQueryOptions, myRunsQueryOptions, recentChatsQueryOptions } from './home-queries';

/**
 * For everyone who does not oversee the engine: the agents they can use first, then their chats, and their own
 * running work only while there is some. It comes last, so appearing never pushes anything down.
 */
export function MemberHome() {
    const agentsVisible = useAllows({ permission: 'agents.read' });
    const chatsVisible = useAllows({ permission: 'chats.read' });
    const runsVisible = useAllows({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' });
    return (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
            {agentsVisible ? <MemberAgents /> : null}
            <div className="flex min-w-0 flex-col gap-6">
                {chatsVisible ? <RecentChats /> : null}
                {runsVisible ? <MyRuns /> : null}
            </div>
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
            chatAction
        />
    );
}

/** Only while something of theirs is queued or running; an empty card here would only push the useful parts away. */
function MyRuns() {
    const engineApi = useEngineApi();
    const { memberId } = useCurrentMember();
    const query = useQuery(myRunsQueryOptions(engineApi, memberId));
    if (!query.isError && (query.data === undefined || query.data.items.length === 0)) return null;
    return (
        <HomeWidget title={m.home_my_runs()} query={query} skeleton={rowsSkeleton}>
            {(page) => (
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
            )}
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
                    <NoChatsYet />
                ) : (
                    <ul className="flex flex-col divide-y divide-divider">
                        {page.items.map((chat) => (
                            <li key={chat.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
                                <Link
                                    to="/agents/$agentId/chat/$chatId"
                                    params={{ agentId: chat.agentId, chatId: chat.id }}
                                    className="min-w-0 truncate"
                                >
                                    {chatName(chat)}
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

/** Invites the first chat with the first agent they can use, where they may start one. */
function NoChatsYet() {
    const agentsVisible = useAllows({ permission: 'agents.read' });
    const canChat = useAllows({ permission: 'chats.write' }) && agentsVisible;
    const agents = useQuery({ ...memberAgentsQueryOptions(useEngineApi()), enabled: canChat });
    const agent = canChat ? agents.data?.items[0] : undefined;
    return (
        <EmptyState
            icon={<MessageSquare />}
            title={m.home_recent_chats_empty()}
            description={agent === undefined ? m.home_recent_chats_empty_body() : m.home_recent_chats_start_body()}
            headingLevel={3}
            {...(agent === undefined
                ? {}
                : {
                      action: (
                          <ButtonLink to="/agents/$agentId/chat" params={{ agentId: agent.id }} variant="primary">
                              <MessageSquare aria-hidden className="size-4" />
                              {m.home_chat_start({ name: agent.name })}
                          </ButtonLink>
                      ),
                  })}
        />
    );
}
