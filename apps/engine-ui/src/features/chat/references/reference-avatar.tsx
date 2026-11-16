import { AgentAvatar } from '../../agents/agent-avatar';
import type { AgentAvatarSize } from '../../agents/agent-avatar';
import { useAgentLook } from '../../home/use-agent-look';
import type { ReferenceAgent } from './thread-references';

/**
 * An agent of a thread with the picture it has everywhere else: its image, else its illustration. Outside a thread
 * (the book's test chat) or before the project's agents load, the shared agents query fills in the profile.
 */
export function ReferenceAvatar({ agent, size }: { readonly agent: ReferenceAgent; readonly size: AgentAvatarSize }) {
    const look = useAgentLook(agent.key);
    const known = agent.origin !== undefined;
    return (
        <AgentAvatar
            name={agent.name}
            agentKey={agent.key}
            profile={
                known
                    ? {
                          avatarUrl: agent.avatarUrl,
                          color: agent.profileColor,
                          description: agent.description ?? undefined,
                          illustration: agent.illustration,
                      }
                    : look.profile
            }
            origin={known ? agent.origin : look.origin}
            size={size}
        />
    );
}
