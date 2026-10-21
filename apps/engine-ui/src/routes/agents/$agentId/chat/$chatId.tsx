import { createFileRoute } from '@tanstack/react-router';

import { loadChat } from '../../../../features/chat/chat-loader';
import { ChatPage } from '../../../../features/chat/chat-page';
import { ChatNotFound, ChatPending } from '../../../../features/chat/chat-route-states';

export const Route = createFileRoute('/agents/$agentId/chat/$chatId')({
    loader: ({ context, params }) => loadChat(context, params.agentId, params.chatId),
    component: ChatPage,
    pendingComponent: ChatPending,
    notFoundComponent: ChatNotFound,
});
