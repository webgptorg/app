import { createFileRoute, Outlet } from '@tanstack/react-router';

import { requireFeature } from '../../../../app/registry/require-feature';
import { useChatEventSync } from '../../../../features/chat/use-chat-event-sync';

export const Route = createFileRoute('/agents/$agentId/chat')({
    beforeLoad: requireFeature('chat', { agentTab: 'chat' }),
    component: AgentChatSection,
});

function AgentChatSection() {
    useChatEventSync();
    return <Outlet />;
}
