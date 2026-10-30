import { AgentId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { redirectToChatTable } from '../../../../features/chat/chat-home-redirect';
import { ChatListSearch } from '../../../../features/chat/chat-list-search';
import { chatListQueryOptions } from '../../../../features/chat/chat-queries';
import { NewChatPage } from '../../../../features/chat/new-chat-page';

export const Route = createFileRoute('/agents/$agentId/chat/')({
    staticData: { fillViewport: true },
    validateSearch: ChatListSearch,
    beforeLoad: redirectToChatTable,
    // The recent list's first page, not awaited: the message box should not wait for it.
    loader: ({ context, params }) => {
        const agentId = AgentId.safeParse(params.agentId).data;
        if (agentId === undefined) return;
        context.queryClient.query(chatListQueryOptions(context.engineApi, agentId, {})).catch(() => undefined);
    },
    component: NewChatPage,
});
