import type { AgentProfile } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { agentListQueryOptions } from '../agents/agents-queries';
import { agentColor } from '../chat/references/agent-color';
import { AGENT_LOOK_PARAMS } from './agent-look-params';

export interface AgentLook {
    readonly profile: Pick<AgentProfile, 'avatarUrl' | 'color'>;
    /** `--tint` value: the profile colour, else the key's palette hue. */
    readonly color: string;
}

/** How an agent looks (picture and colour) by its key, before or without its profile: then by its key's hue. */
export function useAgentLook(agentKey: string): AgentLook {
    const allowed = useAllows({ permission: 'agents.read' });
    const agents = useQuery({ ...agentListQueryOptions(useEngineApi(), AGENT_LOOK_PARAMS), enabled: allowed });
    const agent = agents.data?.items.find((item) => item.id === agentKey);
    const profile = { avatarUrl: agent?.profile.avatarUrl ?? null, color: agent?.profile.color ?? null };
    return { profile, color: agentColor(profile.color, agentKey) };
}
