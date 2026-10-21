import { createFileRoute } from '@tanstack/react-router';

import { AgentDetailFrame } from '../../../features/agents/agent-detail-frame';
import { loadAgentDetail } from '../../../features/agents/agent-detail-loader';
import { AgentDetailPending, AgentNotFound } from '../../../features/agents/agent-route-states';

export const Route = createFileRoute('/agents/$agentId')({
    loader: ({ context, params }) => loadAgentDetail(context, params.agentId),
    component: AgentDetailFrame,
    pendingComponent: AgentDetailPending,
    notFoundComponent: AgentNotFound,
});
