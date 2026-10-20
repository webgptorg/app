import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../../app/registry/require-feature';
import { AgentOverview } from '../../../features/agents/agent-overview';

export const Route = createFileRoute('/agents/$agentId/')({
    beforeLoad: requireFeature('agents', { agentTab: 'overview' }),
    component: AgentOverview,
});
