import type { ReadChat } from '@ptbk/engine-api';
import { MessageSquare } from 'lucide-react';

import { LookedUpAgentAvatar } from '../agents/looked-up-agent-avatar';

const AVATARS = 3;

/** The thread's agents as overlapping avatars, first joined first; people are implied. */
export function ChatAvatars({ chat }: { readonly chat: Pick<ReadChat, 'members'> }) {
    const agents = chat.members.filter((member) => member.kind === 'agent').slice(0, AVATARS);
    if (agents.length === 0) {
        return (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-soft text-text-muted">
                <MessageSquare aria-hidden className="size-3.5" />
            </span>
        );
    }
    return (
        <span aria-hidden="true" className="flex w-10 shrink-0 -space-x-2">
            {agents.map((agent) => (
                <LookedUpAgentAvatar
                    key={agent.key}
                    agentKey={agent.key}
                    name={agent.name}
                    size="xs"
                    className="ring-2 ring-surface"
                />
            ))}
        </span>
    );
}
