import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { agentListQueryOptions } from '../agents/agents-queries';
import { AGENT_LOOK_PARAMS } from '../home/agent-look-params';

/** An agent's name from the shared agents query every avatar reads; `null` until known, or for no agent. */
export function useAgentName(agentId: string | null): string | null {
    const allowed = useAllows({ permission: 'agents.read' });
    const agents = useQuery({ ...agentListQueryOptions(useEngineApi(), AGENT_LOOK_PARAMS), enabled: allowed });
    if (agentId === null) return null;
    return agents.data?.items.find((agent) => agent.id === agentId)?.name ?? null;
}
