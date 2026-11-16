import { Button } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { SquarePen } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { useAgentIdParam } from '../agents/agent-detail-route';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { usePermissions } from '../session/use-permissions';
import { ThreadList } from './thread-list';
import { useNewChat } from './use-new-chat';

/** The agent's Chat tab: a quiet heading with the one action (a new thread with it), then the threads it is in. */
export function AgentThreadsPage() {
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const { can } = usePermissions();
    const newChat = useNewChat();
    return (
        <section aria-labelledby="agent-chats" className="flex flex-col gap-3">
            <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
                <h2 id="agent-chats" className="text-sm font-semibold text-text-muted">
                    {m.chat_agent_threads({ name: agent.name })}
                </h2>
                {can('chats.write') ? (
                    <Button
                        variant="primary"
                        size="sm"
                        loading={newChat.starting}
                        onClick={() => {
                            newChat.start(agentId);
                        }}
                    >
                        <SquarePen aria-hidden className="size-4" />
                        {m.chat_new_with({ name: agent.name })}
                    </Button>
                ) : null}
            </div>
            <ThreadList params={{ agentId }} />
        </section>
    );
}
