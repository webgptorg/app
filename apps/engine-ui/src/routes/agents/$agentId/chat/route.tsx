import { createFileRoute, Outlet } from '@tanstack/react-router';

import { requireFeature } from '../../../../app/registry/require-feature';
import { useChatEventSync } from '../../../../features/chat/use-chat-event-sync';

// The chat list and every chat share this layout, so the event subscription survives moving between them.
export const Route = createFileRoute('/agents/$agentId/chat')({
    beforeLoad: requireFeature('chat', { agentTab: 'chat' }),
    component: ChatSection,
});

function ChatSection() {
    useChatEventSync();
    return <Outlet />;
}
