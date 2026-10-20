import type { AgentRunStatus } from '@ptbk/engine-api';
import { useQueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { agentKeys } from './agents-keys';

/**
 * Keeps agent queries current from the engine's event stream while agent screens are open: `agent.status` is written
 * straight into the cached status (no refetch), `agent.changed` refetches that agent and the lists, and a reconnect
 * refetches every agent query once, since events in the gap may be gone.
 */
export function useAgentEventSync(): void {
    const queryClient = useQueryClient();
    useEngineEvents({
        onEvent: (event) => {
            if (event.type === 'agent.status') {
                const status: AgentRunStatus = { state: event.state, since: event.since };
                queryClient.setQueryData(agentKeys.status(event.agentId), status);
            } else if (event.type === 'agent.changed') {
                void queryClient.invalidateQueries({ queryKey: agentKeys.detail(event.agentId) });
                void queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
            }
        },
        onReconnect: () => {
            void queryClient.invalidateQueries({ queryKey: agentKeys.all });
        },
    });
}
