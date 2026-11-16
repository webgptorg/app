import type { AgentOrigin } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { NO_AGENT_PROFILE } from '../agents/agent-avatar';
import type { AgentAvatarProfile } from '../agents/agent-avatar';
import { agentListQueryOptions } from '../agents/agents-queries';
import { AGENT_LOOK_PARAMS } from '../home/agent-look-params';

/**
 * How an agent looks when the engine names it but gives no ID, as Wallet requests do: its picture and colour when an
 * agent of that name is listed, else the hue its name hashes to. Shares Home's agent query, so it adds no request.
 */
export function useAgentLookByName(name: string): {
    readonly key: string;
    readonly profile: AgentAvatarProfile;
    readonly origin: AgentOrigin | undefined;
} {
    const allowed = useAllows({ permission: 'agents.read' });
    const agents = useQuery({ ...agentListQueryOptions(useEngineApi(), AGENT_LOOK_PARAMS), enabled: allowed });
    const agent = agents.data?.items.find((item) => item.name === name);
    return {
        key: agent?.id ?? name,
        profile: agent?.profile ?? NO_AGENT_PROFILE,
        origin: agent?.origin,
    };
}
