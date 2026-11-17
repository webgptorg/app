import type { AgentOrigin } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { NO_AGENT_PROFILE } from '../agents/agent-avatar';
import type { AgentAvatarProfile } from '../agents/agent-avatar';
import { agentListQueryOptions } from '../agents/agents-queries';
import { agentColor } from '../chat/references/agent-color';
import { AGENT_LOOK_PARAMS } from './agent-look-params';

export interface AgentLook {
    /** The whole profile `AgentAvatar` reads: picture, colour, role and illustration. */
    readonly profile: AgentAvatarProfile;
    /** `undefined` until (or unless) the agent is among the engine's agents. */
    readonly origin: AgentOrigin | undefined;
    /** `--tint` value: the profile colour, else the key's palette hue. */
    readonly color: string;
}

/** How an agent looks (picture and colour) by its key, before or without its profile: then by its key's hue. */
export function useAgentLook(agentKey: string): AgentLook {
    const allowed = useAllows({ permission: 'agents.read' });
    const agents = useQuery({ ...agentListQueryOptions(useEngineApi(), AGENT_LOOK_PARAMS), enabled: allowed });
    const agent = agents.data?.items.find((item) => item.id === agentKey);
    const profile = agent?.profile ?? NO_AGENT_PROFILE;
    return { profile, origin: agent?.origin, color: agentColor(profile.color, agentKey) };
}
