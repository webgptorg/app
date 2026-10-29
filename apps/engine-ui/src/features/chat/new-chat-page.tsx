import { useSuspenseQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { useAgentIdParam } from '../agents/agent-detail-route';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { Composer } from './composer';
import { RecentChatsButton, WithRecentChats } from './recent-chats';
import { useStartChat } from './use-start-chat';

/**
 * Where the Chat tab lands for members who may write: an empty conversation with the message box, as in any chat
 * app. The first message creates the chat and opens it; past chats are in the recent list beside it.
 */
export function NewChatPage() {
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const startChat = useStartChat(agentId);
    // Engine data, shown as text only: the book's author may write anything here.
    const initialMessage = agent.profile.initialMessage?.trim() ?? '';
    const greeting = initialMessage === '' ? m.chat_greeting({ name: agent.name }) : initialMessage;

    return (
        <WithRecentChats agentId={agentId}>
            {/* On a phone the box sits at the bottom like a messenger's; with room to spare it joins the greeting. */}
            <div className="flex min-h-0 flex-1 flex-col gap-4 @2xl:justify-center @2xl:gap-6">
                <h2 className="sr-only">{m.chat_new_label()}</h2>
                <RecentChatsButton agentId={agentId} className="self-start @2xl:hidden" />
                {/* `m-auto` rather than `justify-center`: a long greeting scrolls from its top instead of being cut off. */}
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @2xl:flex-initial">
                    <div className="m-auto flex max-w-prose flex-col items-center gap-3 py-6 text-center">
                        <AgentAvatar name={agent.name} profile={agent.profile} size="lg" />
                        <p className="text-lg break-words whitespace-pre-line">{greeting}</p>
                    </div>
                </div>
                <Composer
                    label={m.chat_new_label()}
                    labelHidden
                    placeholder={m.chat_composer_placeholder({ name: agent.name })}
                    busy={false}
                    onSend={startChat}
                    className="mx-auto w-full max-w-2xl shrink-0"
                />
            </div>
        </WithRecentChats>
    );
}
