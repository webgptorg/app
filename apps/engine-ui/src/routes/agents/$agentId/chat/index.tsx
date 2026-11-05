import { createFileRoute } from '@tanstack/react-router';

import { AgentThreadsPage } from '../../../../features/chat/agent-threads-page';

export const Route = createFileRoute('/agents/$agentId/chat/')({
    component: AgentThreadsPage,
});
