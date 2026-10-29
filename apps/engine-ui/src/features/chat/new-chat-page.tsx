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
            <div className="flex min-h-0 flex-1 flex-col">
                <RecentChatsButton agentId={agentId} className="self-start @2xl:hidden" />
                {/* `m-auto` rather than `justify-center`: a long greeting scrolls from its top instead of being cut off. */}
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                    <div className="m-auto flex w-full flex-col items-center gap-6 px-1 py-6">
                        <div className="flex max-w-prose flex-col items-center gap-3 text-center">
                            <AgentAvatar name={agent.name} profile={agent.profile} size="lg" />
                            <h2 className="font-display text-xl font-semibold break-words">{agent.name}</h2>
                            <p className="break-words whitespace-pre-line text-text-muted">{greeting}</p>
                        </div>
                        <Composer
                            label={m.chat_new_label()}
                            labelHidden
                            placeholder={m.chat_composer_placeholder({ name: agent.name })}
                            busy={false}
                            onSend={startChat}
                            className="w-full max-w-2xl"
                        />
                    </div>
                </div>
            </div>
        </WithRecentChats>
    );
}
