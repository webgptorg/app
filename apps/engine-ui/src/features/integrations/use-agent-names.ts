import type { AgentId, ReadAgent } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { agentListQueryOptions } from '../agents/agents-queries';

/** The first page of agents by name; an agent beyond it still shows, by its ID. */
const AGENT_LIMIT = 100;

/**
 * Agents for integration rows, filters and details, from one cached `GET /agents` shared with the agent pickers; empty
 * without `agents.read`, where rows name an agent by its ID.
 */
export function useAgents(): ReadonlyMap<AgentId, ReadAgent> {
    const allowed = useAllows({ permission: 'agents.read' });
    const agents = useQuery({
        ...agentListQueryOptions(useEngineApi(), { limit: AGENT_LIMIT, sort: 'name' }),
        enabled: allowed,
    });
    return useMemo(() => new Map((agents.data?.items ?? []).map((agent) => [agent.id, agent])), [agents.data]);
}
