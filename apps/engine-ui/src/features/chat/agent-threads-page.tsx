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

/** The agent's Chat tab: the threads it is in, and a new thread with it. */
export function AgentThreadsPage() {
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const { can } = usePermissions();
    const newChat = useNewChat();
    return (
        <section aria-labelledby="agent-chats" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="agent-chats" className="text-base font-semibold">
                    {m.chat_agent_threads({ name: agent.name })}
                </h2>
                {can('chats.write') ? (
                    <Button
                        variant="primary"
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
