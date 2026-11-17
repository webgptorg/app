import { AgentAvatar } from '../../agents/agent-avatar';
import type { AgentAvatarSize } from '../../agents/agent-avatar';
import { LookedUpAgentAvatar } from '../../agents/looked-up-agent-avatar';
import { useThreadReferences } from './thread-references';
import type { ReferenceAgent } from './thread-references';

/**
 * An agent of a thread with the picture it has everywhere else: its image, else its illustration. Outside a thread
 * (the book's test chat) there are no references, so the shared agents query supplies the profile.
 */
export function ReferenceAvatar({ agent, size }: { readonly agent: ReferenceAgent; readonly size: AgentAvatarSize }) {
    if (useThreadReferences() === null) {
        return <LookedUpAgentAvatar agentKey={agent.key} name={agent.name} size={size} />;
    }
    return (
        <AgentAvatar
            name={agent.name}
            agentKey={agent.key}
            profile={{
                avatarUrl: agent.avatarUrl,
                color: agent.profileColor,
                description: agent.description ?? undefined,
                illustration: agent.illustration,
            }}
            origin={agent.origin}
            size={size}
        />
    );
}
