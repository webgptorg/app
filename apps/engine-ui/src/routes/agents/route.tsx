import { createFileRoute, Outlet } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { useAgentEventSync } from '../../features/agents/use-agent-event-sync';

// The list and every agent page share this layout, so the event subscription survives moving between them.
export const Route = createFileRoute('/agents')({
    beforeLoad: requireFeature('agents'),
    component: AgentsSection,
});

function AgentsSection() {
    useAgentEventSync();
    return <Outlet />;
}
