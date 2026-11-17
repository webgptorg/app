import { AgentId, ChatId } from '@ptbk/engine-api';
import type { ReadChat } from '@ptbk/engine-api';
import { ActionMenu, IconButton, StatusPill } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { MessagesSquare, SquarePen } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { EntityChip } from '../entities/entity-chip';
import { useDocumentTitle } from '../shell/document-title';
import { Breadcrumbs, Crumb } from '../shell/page';
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
    // A phone keeps the title and ⋯; who is in the thread shows on every message anyway.
    return (
        <ul aria-label={m.chat_participants()} className="flex min-w-0 flex-wrap items-center gap-1.5 max-sm:hidden">
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

/** A fresh thread with the main agent, in one click where there is room; on a phone it is in the ⋯ menu. */
function NewChatButton({ main }: { readonly main: ThreadAgent | undefined }) {
    const { can } = usePermissions();
    const newChat = useNewChat();
    const mainId = main?.id ?? null;
    if (main === undefined || mainId === null || !can('chats.write')) return null;
    return (
        <IconButton
            variant="ghost"
            size="sm"
            className="max-sm:hidden"
            label={m.chat_new_with({ name: main.name })}
            icon={<SquarePen aria-hidden className="size-4" />}
            loading={newChat.starting}
            onClick={() => {
                newChat.start(mainId);
            }}
        />
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

    // The page takes the rest of the screen (`fillViewport`), so the composer is in view without scrolling and the
    // header stays put. The header spans the content area; the conversation keeps its reading column.
    return (
        <section aria-labelledby="page-title" className="flex min-h-[30rem] min-w-0 flex-1 flex-col">
            <header
                data-page-header=""
                className="flex min-w-0 items-center justify-between gap-4 border-b border-hairline py-3"
            >
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="max-sm:hidden">
                        <Breadcrumbs
                            trail={[
                                <Crumb key="chats" to="/chats">
                                    {m.nav_chats()}
                                </Crumb>,
                            ]}
                        />
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
                        <h1
                            id="page-title"
                            title={title}
                            className="min-w-0 truncate text-xl font-semibold tracking-display max-sm:text-base"
                        >
                            {title}
                        </h1>
                        <Participants agents={agents} />
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {chat.working.length === 0 ? null : (
                        <StatusPill tone="live" variant="quiet" className="max-sm:hidden">
                            {m.chat_ref_status_working()}
                        </StatusPill>
                    )}
                    <NewChatButton main={agents[0]} />
                    <ThreadMenu main={agents[0]} />
                </div>
            </header>
            {/* Keyed: the stream, the draft and the scroll position belong to one thread, not to the route. */}
            <ChatPanel key={chat.id} chat={chat} canWrite={can('chats.write')} fill />
        </section>
    );
}
