import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../../app/registry/require-feature';
import { AgentSettings } from '../../../features/agents/agent-settings';

export const Route = createFileRoute('/agents/$agentId/settings')({
    beforeLoad: requireFeature('agents', { agentTab: 'settings' }),
    component: AgentSettings,
});
