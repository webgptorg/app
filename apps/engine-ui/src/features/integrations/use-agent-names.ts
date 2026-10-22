import type { AgentId } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { agentListQueryOptions } from '../agents/agents-queries';

/** The first page of agents by name; an agent beyond it still shows, by its ID. */
const AGENT_LIMIT = 100;

/** Agent names for integration rows and details, from one cached `GET /agents` shared with the agent pickers. */
export function useAgentNames(): ReadonlyMap<AgentId, string> {
    const agents = useQuery(agentListQueryOptions(useEngineApi(), { limit: AGENT_LIMIT, sort: 'name' }));
    return useMemo(() => new Map((agents.data?.items ?? []).map((agent) => [agent.id, agent.name])), [agents.data]);
}
