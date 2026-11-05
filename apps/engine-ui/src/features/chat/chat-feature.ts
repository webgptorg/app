import { useQuery } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { AGENT_TABS, defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { chatListQueryOptions } from './chat-queries';

/** Threads with an outstanding question to the User; unread alone asks nothing, so it does not count. */
function useThreadsNeedingYou(): number {
    const list = useQuery(chatListQueryOptions(useEngineApi(), {}));
    return list.data?.items.filter((chat) => chat.questions.length > 0).length ?? 0;
}

/** Chats: the engine's threads, with Chatter as the default partner, and each agent's Chat tab. */
export const chatFeature = defineFeature({
    id: 'chat',
    requires: { permission: 'chats.read' },
    nav: {
        group: 'work',
        order: 25,
        label: m.nav_chats,
        icon: MessagesSquare,
        to: '/chats',
        useBadge: useThreadsNeedingYou,
    },
    agentTabs: [{ ...AGENT_TABS.chat, label: m.agent_tab_chat, to: '/agents/$agentId/chat' }],
    commands: [{ id: 'chats.open', label: m.nav_chats, keywords: () => [m.chat_new_label()], to: '/chats' }],
});
