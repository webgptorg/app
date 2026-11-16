import { AgentId, ChatId } from '@ptbk/engine-api';
import type { ReadChat } from '@ptbk/engine-api';
import { ActionMenu } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { MessagesSquare, SquarePen } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { EntityChip } from '../entities/entity-chip';
import { useDocumentTitle } from '../shell/document-title';
import { Crumb, PageHeader } from '../shell/page';
import { usePermissions } from '../session/use-permissions';
import { ChatPanel } from './chat-panel';
import { chatName } from './chat-name';
import { chatQueryOptions } from './chat-queries';
import { useNewChat } from './use-new-chat';

const route = getRouteApi('/chats/$chatId');
const SHOWN_PARTICIPANTS = 4;

interface ThreadAgent {
    readonly id: AgentId | null;
    readonly name: string;
}

/** The thread's agents in the order they joined; the first is its main agent. People are implied. */
function threadAgents(chat: Pick<ReadChat, 'members'>): readonly ThreadAgent[] {
    return chat.members
        .filter((member) => member.kind === 'agent')
        .map((member) => ({ id: AgentId.safeParse(member.key).data ?? null, name: member.name }));
}

/** Who is in the thread, as chips with their cards; a long cast ends in a quiet "+n". */
function Participants({ agents }: { readonly agents: readonly ThreadAgent[] }) {
    if (agents.length === 0) return null;
    const hidden = agents.slice(SHOWN_PARTICIPANTS);
    return (
        <ul aria-label={m.chat_participants()} className="flex min-w-0 flex-wrap items-center gap-1.5">
            {agents.slice(0, SHOWN_PARTICIPANTS).map((agent) => (
                <li key={agent.id ?? agent.name} className="flex min-w-0">
                    <EntityChip kind="agent" id={agent.id} name={agent.name} />
                </li>
            ))}
            {hidden.length === 0 ? null : (
                <li className="text-xs text-text-muted tabular-nums">
                    <span aria-hidden="true">{m.chat_participants_more({ count: hidden.length })}</span>
                    <span className="sr-only">{hidden.map((agent) => agent.name).join(', ')}</span>
                </li>
            )}
        </ul>
    );
}

/** A fresh thread with the main agent, and that agent's other threads; nothing here deletes a conversation. */
function ThreadMenu({ main }: { readonly main: ThreadAgent | undefined }) {
    const { can } = usePermissions();
    const agentsVisible = useAllows({ permission: 'agents.read' });
    const newChat = useNewChat();
    const navigate = useNavigate();
    const mainId = main?.id ?? null;
    if (main === undefined || mainId === null) return null;
    const items: MenuEntry[] = [];
    if (can('chats.write')) {
        items.push({
            kind: 'item',
            id: 'new',
            label: m.chat_new_with({ name: main.name }),
            icon: <SquarePen aria-hidden className="size-4" />,
            disabled: newChat.starting,
            onSelect: () => {
                newChat.start(mainId);
            },
        });
    }
    if (agentsVisible) {
        items.push({
            kind: 'item',
            id: 'threads',
            label: m.chat_agent_threads({ name: main.name }),
            icon: <MessagesSquare aria-hidden className="size-4" />,
            onSelect: () => {
                void navigate({ to: '/agents/$agentId/chat', params: { agentId: mainId } });
            },
        });
    }
    return <ActionMenu items={items} label={m.chat_more_actions()} variant="ghost" size="sm" />;
}

/**
 * One thread: a slim header (where it sits, its title, which changes with the topic, who is in it and a few
 * actions), then the conversation. Any member who may write writes in any thread; nobody owns one.
 */
export function ThreadPage() {
    const chatId = ChatId.parse(route.useParams({ select: (params) => params.chatId }));
    const { data: chat } = useSuspenseQuery(chatQueryOptions(useEngineApi(), chatId));
    const { can } = usePermissions();
    const title = chatName(chat);
    const agents = threadAgents(chat);
    useDocumentTitle(title, m.nav_chats());

    // The page takes the rest of the screen, so the composer is in view without scrolling and the header stays put.
    return (
        <section aria-labelledby="page-title" className="flex h-(--main-fill-height) min-h-[30rem] min-w-0 flex-col">
            {/* A hairline under the header: the conversation scrolls beneath it. */}
            <div className="border-b border-hairline">
                <PageHeader
                    title={title}
                    breadcrumbs={[
                        <Crumb key="chats" to="/chats">
                            {m.nav_chats()}
                        </Crumb>,
                    ]}
                    actions={
                        <>
                            <Participants agents={agents} />
                            <ThreadMenu main={agents[0]} />
                        </>
                    }
                />
            </div>
            {/* Keyed: the stream, the draft and the scroll position belong to one thread, not to the route. */}
            <ChatPanel key={chat.id} chat={chat} canWrite={can('chats.write')} fill />
        </section>
    );
}
