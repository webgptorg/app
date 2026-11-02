import { ChatId } from '@ptbk/engine-api';
import { Badge, Banner } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { useAgentIdParam } from '../agents/agent-detail-route';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { useCurrentMember } from '../session/use-current-member';
import { usePermissions } from '../session/use-permissions';
import { ChatPanel } from './chat-panel';
import { chatQueryOptions } from './chat-queries';
import { chatName, sourceLabel } from './chat-source';
import { ChatStarter } from './chat-starter';
import { RecentChatsButton, WithRecentChats } from './recent-chats';

const route = getRouteApi('/agents/$agentId/chat/$chatId');

/**
 * One chat. Whether the member may write is decided by permission and by whose chat it is, never by role: the owner
 * reads every chat, including other members' and public visitors', but writes only in their own.
 */
export function ChatPage() {
    const engineApi = useEngineApi();
    const agentId = useAgentIdParam();
    const chatId = ChatId.parse(route.useParams({ select: (params) => params.chatId }));
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(engineApi, agentId));
    const { data: chat } = useSuspenseQuery(chatQueryOptions(engineApi, chatId));
    const me = useCurrentMember();
    const { can } = usePermissions();
    const ownChat = chat.createdBy === me.memberId;
    const canWrite = ownChat && can('chats.write');

    // The agent frame gives this page the rest of the screen, so the composer is in view without scrolling. Where the
    // recent list has no room beside the chat, the header links to all chats and opens the list as a drawer.
    return (
        <WithRecentChats agentId={agentId}>
            <section aria-labelledby="chat-title" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <Link
                        to="/agents/$agentId/chat/all"
                        params={{ agentId }}
                        variant="standalone"
                        className="inline-flex shrink-0 items-center gap-1 text-sm @2xl:hidden"
                    >
                        <ArrowLeft aria-hidden className="size-4" />
                        {m.chat_back()}
                    </Link>
                    <RecentChatsButton agentId={agentId} className="ms-auto @2xl:hidden" />
                    <div className="flex min-w-0 basis-full items-center gap-3 @2xl:basis-auto @2xl:flex-1">
                        <h2 id="chat-title" className="min-w-0 flex-1 truncate text-base font-semibold">
                            {chatName(chat)}
                        </h2>
                        <div className="flex shrink-0 items-center gap-2 text-sm text-text-muted">
                            <Badge>{sourceLabel(chat.source)}</Badge>
                            <ChatStarter chat={chat} />
                        </div>
                    </div>
                </div>
                {ownChat ? null : <Banner tone="info">{m.chat_read_only()}</Banner>}
                {/* Keyed: the stream, the draft and the scroll position belong to one chat, not to the route. */}
                <ChatPanel
                    key={chat.id}
                    chat={chat}
                    agentName={agent.name}
                    agentProfile={agent.profile}
                    canWrite={canWrite}
                    fill
                />
            </section>
        </WithRecentChats>
    );
}
