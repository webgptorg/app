import { createFileRoute } from '@tanstack/react-router';

import { loadChat } from '../../features/chat/chat-loader';
import { ChatNotFound, ChatPending } from '../../features/chat/chat-route-states';
import { ThreadPage } from '../../features/chat/thread-page';

export const Route = createFileRoute('/chats/$chatId')({
    staticData: { fillViewport: true },
    loader: ({ context, params }) => loadChat(context, params.chatId),
    component: ThreadPage,
    pendingComponent: ChatPending,
    notFoundComponent: ChatNotFound,
});
