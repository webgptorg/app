import { useAgentLook } from '../home/use-agent-look';
import { AgentAvatar } from './agent-avatar';
import type { AgentAvatarSize } from './agent-avatar';

/**
 * The avatar of an agent known only by key and name (a chat member, a chip, a recent pick): its profile comes from the
 * shared agents query, so it gets the same picture and illustration as in the agents list.
 */
export function LookedUpAgentAvatar({
    agentKey,
    name,
    size,
    className,
}: {
    readonly agentKey: string;
    readonly name: string;
    readonly size?: AgentAvatarSize;
    readonly className?: string | undefined;
}) {
    const look = useAgentLook(agentKey);
    return (
        <AgentAvatar
            name={name}
            agentKey={agentKey}
            profile={look.profile}
            origin={look.origin}
            {...(size === undefined ? {} : { size })}
            className={className}
        />
    );
}
