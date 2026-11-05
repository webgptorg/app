import { Button, buttonClassName, Menu } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, SquarePen } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { agentListQueryOptions } from '../agents/agents-queries';
import { usePermissions } from '../session/use-permissions';
import { useNewChat } from './use-new-chat';

/**
 * "New chat" opens a thread with Chatter, the engine's default partner; the menu beside it starts one with another
 * agent instead. Chatter brings other agents in as the conversation needs them.
 */
export function NewChatActions() {
    const { can } = usePermissions();
    const newChat = useNewChat();
    const agents = useQuery({
        ...agentListQueryOptions(useEngineApi(), { sort: 'name' }),
        enabled: can('chats.write') && can('agents.read'),
    });
    if (!can('chats.write')) return null;
    const others = (agents.data?.items ?? []).filter((agent) => agent.name.toLowerCase() !== 'chatter');
    return (
        <div className="flex items-center gap-2">
            <Button
                variant="primary"
                loading={newChat.starting}
                onClick={() => {
                    newChat.start();
                }}
            >
                <SquarePen aria-hidden className="size-4" />
                {m.chat_new_label()}
            </Button>
            {others.length === 0 ? null : (
                <Menu
                    label={m.chat_new_with_agent()}
                    align="end"
                    trigger={(props) => (
                        <button {...props} type="button" className={buttonClassName('secondary', 'md')}>
                            <span className="sr-only">{m.chat_new_with_agent()}</span>
                            <ChevronDown aria-hidden className="size-4" />
                        </button>
                    )}
                    items={others.map((agent) => ({
                        kind: 'item' as const,
                        id: agent.id,
                        label: agent.name,
                        onSelect: () => {
                            newChat.start(agent.id);
                        },
                    }))}
                />
            )}
        </div>
    );
}
