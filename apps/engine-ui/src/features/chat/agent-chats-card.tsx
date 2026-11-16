import type { AgentId } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { OverviewFailed, OverviewLoading, OverviewSection, overviewLinkClassName } from '../agents/overview-parts';
import { ChatRow } from '../home/recent-chats';
import { chatListQueryOptions } from './chat-queries';

const SHOWN = 4;

/** The agent overview's newest threads with this agent, as Home draws them; nothing at all before the first one. */
export function AgentChatsCard({ agentId }: { readonly agentId: AgentId }) {
    // The same query as the agent's Chat tab, so moving there shows the list at once.
    const list = useQuery(chatListQueryOptions(useEngineApi(), { agentId }));
    if (list.isSuccess && list.data.items.length === 0) return null;
    return (
        <OverviewSection
            title={m.agent_overview_chats()}
            all={
                <Link
                    to="/agents/$agentId/chat"
                    params={{ agentId }}
                    variant="standalone"
                    className={overviewLinkClassName}
                >
                    {m.home_all_chats()}
                </Link>
            }
        >
            {list.isPending ? (
                <OverviewLoading label={m.agent_overview_chats()} />
            ) : list.isError ? (
                <OverviewFailed
                    message={m.chat_load_failed()}
                    onRetry={() => {
                        void list.refetch();
                    }}
                    retrying={list.isFetching}
                />
            ) : (
                <ul className="flex flex-col">
                    {list.data.items.slice(0, SHOWN).map((chat) => (
                        <ChatRow key={chat.id} chat={chat} />
                    ))}
                </ul>
            )}
        </OverviewSection>
    );
}
