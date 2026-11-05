import { createFileRoute, Outlet } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { useChatEventSync } from '../../features/chat/use-chat-event-sync';

// The thread list and every thread share this layout, so the event subscription survives moving between them.
export const Route = createFileRoute('/chats')({
    beforeLoad: requireFeature('chat'),
    component: ChatsSection,
});

function ChatsSection() {
    useChatEventSync();
    return <Outlet />;
}
