import type { AgentId, AgentRunStatus } from '@ptbk/engine-api';
import type { QueryClient } from '@tanstack/react-query';

import { agentKeys } from './agents-keys';

/**
 * Writes a run state into the cache unless the cached one is newer: an event and a stop response can arrive
 * in either order, and the older must not win.
 */
export function writeAgentStatus(queryClient: QueryClient, agentId: AgentId, status: AgentRunStatus): void {
    queryClient.setQueryData<AgentRunStatus | null>(agentKeys.status(agentId), (cached) =>
        cached !== undefined && cached !== null && Date.parse(cached.since) > Date.parse(status.since)
            ? cached
            : status,
    );
}
