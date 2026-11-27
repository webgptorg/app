import { AgentId } from '@ptbk/engine-api';
import type { ReadChat } from '@ptbk/engine-api';
import {
    BrandRobot,
    Button,
    createDataTableColumnHelper,
    DataTable,
    FilterBar,
    filterField,
    RelativeTime,
    StatusPill,
} from '@ptbk/ui';
import type { DataTableColumnDef, DataTableView, FilterBarField } from '@ptbk/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Bot, CalendarClock, CircleDot, MessageSquare, MessagesSquare } from 'lucide-react';
import type { ReactNode } from 'react';

import { useDebouncedSearch } from '../../app/debounced-search';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { readOneParam } from '../../app/search-filters';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { agentListQueryOptions } from '../agents/agents-queries';
import { AGENT_LOOK_PARAMS } from '../home/agent-look-params';
import { chatPreview } from '../home/chat-preview';
import { ChatAvatars } from './chat-avatars';
import type { ChatListParams } from './chat-keys';
import { chatName, threadMembers } from './chat-name';
import { chatEntriesQueryOptions, chatListQueryOptions } from './chat-queries';
import { chatListParams, hasChatFilters, NO_CHAT_FILTERS, needsYou } from './chat-search';
import type { ChatAttention, ChatSearch } from './chat-search';

const ICON = 'size-3.5';
const NO_CHATS: readonly ReadChat[] = [];

/**
 * Needs you: an agent asked something nobody answered; unseen questions are the louder mark. Unread alone is quieter,
 * because new messages do not by themselves ask anything of the User. Working says an agent is replying now.
 */
export function ThreadMark({ chat }: { readonly chat: Pick<ReadChat, 'questions' | 'unread' | 'working'> }) {
    if (needsYou(chat)) {
        const unseen = chat.questions.some((question) => !question.seen);
        return (
            <StatusPill tone="warning" variant={unseen ? 'soft' : 'quiet'}>
                {m.chat_needs_you()}
            </StatusPill>
        );
    }
    if (chat.working.length > 0) return <StatusPill tone="live">{m.home_chat_working()}</StatusPill>;
    if (chat.unread > 0) return <StatusPill tone="info">{m.chat_unread({ count: chat.unread })}</StatusPill>;
    return null;
}

/**
 * The newest words of the thread, never an agent's steps: from the thread's cached messages once the member has
 * opened it, else the engine's preview. Untrusted, rendered as a text node.
 */
function ChatPreviewLine({ chat }: { readonly chat: ReadChat }) {
    const cached = useInfiniteQuery({ ...chatEntriesQueryOptions(useEngineApi(), chat.id), enabled: false }).data;
    const preview = chatPreview(
        chat,
        cached?.pages.flatMap((page) => page.items),
    );
    if (preview === null) return null;
    if (preview.kind === 'working') {
        return <span className="line-clamp-1 text-xs break-words text-text-muted italic">{m.home_chat_working()}</span>;
    }
    return <span className="line-clamp-1 text-xs break-words text-text-muted">{preview.text}</span>;
}

function ChatTitle({ chat }: { readonly chat: ReadChat }) {
    const members = threadMembers(chat);
    return (
        <span className="flex min-w-0 items-center gap-3">
            <ChatAvatars chat={chat} />
            <span className="flex min-w-0 flex-col">
                <Link
                    to="/chats/$chatId"
                    params={{ chatId: chat.id }}
                    variant="standalone"
                    className="line-clamp-1 font-medium break-words text-text"
                >
                    {chatName(chat)}
                </Link>
                {members === '' ? null : <span className="sr-only">{members}</span>}
                <ChatPreviewLine chat={chat} />
            </span>
        </span>
    );
}

const column = createDataTableColumnHelper<ReadChat>();

function columns(): DataTableColumnDef<ReadChat>[] {
    return [
        column.accessor((chat) => chatName(chat), {
            id: 'chat',
            header: m.chat_column_chat(),
            enableSorting: false,
            enableHiding: false,
            meta: { priority: 0, grow: true, icon: <MessageSquare className={ICON} /> },
            cell: ({ row }) => <ChatTitle chat={row.original} />,
        }),
        column.display({
            id: 'state',
            header: m.chat_column_state(),
            meta: { priority: 1, icon: <CircleDot className={ICON} /> },
            cell: ({ row }) => <ThreadMark chat={row.original} />,
        }),
        column.accessor((chat) => chat.lastMessageAt ?? chat.updatedAt, {
            id: 'updated',
            header: m.chat_column_updated(),
            enableSorting: false,
            enableHiding: false,
            meta: { priority: 2, trailing: true, numeric: true, icon: <CalendarClock className={ICON} /> },
            cell: ({ row }) => (
                <RelativeTime
                    value={new Date(row.original.lastMessageAt ?? row.original.updatedAt)}
                    className="whitespace-nowrap text-text-muted"
                />
            ),
        }),
    ];
}

export interface ThreadListFilters {
    readonly search: ChatSearch;
    /** Applies a change to the URL, the only place the filters live. */
    readonly onChange: (change: Partial<ChatSearch>) => void;
}

export interface ThreadListProps {
    /** Which threads: every thread, or an agent's. */
    readonly params: ChatListParams;
    /** Replaces the empty state when there are no threads at all. */
    readonly empty?: ReactNode;
    /** A search and filter bar above the list, bound to the URL. */
    readonly filters?: ThreadListFilters;
}

/** Threads, newest first, as rich rows: who is in them, the title, their newest words, what needs you, and when. */
export function ThreadList({ params, empty, filters }: ThreadListProps) {
    const query = filters === undefined ? params : { ...chatListParams(filters.search), ...params };
    const list = useQuery(chatListQueryOptions(useEngineApi(), query));
    const all = list.data?.items ?? NO_CHATS;
    // The engine has no attention filter; the newest page is where open questions are.
    const items = filters?.search.needs === 'you' ? all.filter(needsYou) : all;
    const filtered = filters !== undefined && hasChatFilters(filters.search);
    const clear = () => {
        filters?.onChange(NO_CHAT_FILTERS);
    };
    if (!filtered && empty !== undefined && list.isSuccess && items.length === 0) return empty;
    return (
        <DataTable<ReadChat>
            caption={m.chat_list_label()}
            columns={columns()}
            data={items}
            getRowId={(chat) => chat.id}
            getRowLabel={(chat) => chatName(chat)}
            loading={list.isPending}
            fetching={list.isFetching && !list.isPending}
            {...(list.isError
                ? {
                      error: {
                          message: m.chat_load_failed(),
                          onRetry: () => {
                              void list.refetch();
                          },
                          retrying: list.isFetching,
                      },
                  }
                : {})}
            empty={
                filtered
                    ? {
                          title: m.chat_no_results(),
                          description: m.chat_no_results_hint(),
                          action: <Button onClick={clear}>{m.chat_clear_filters()}</Button>,
                      }
                    : {
                          icon: <MessagesSquare />,
                          illustration: <BrandRobot pose="working" />,
                          title: m.chat_empty_title(),
                          description: m.chat_empty_body(),
                      }
            }
            {...(filters === undefined
                ? {}
                : {
                      toolbar: (view: DataTableView) => (
                          <ChatFilters
                              view={view}
                              filters={filters}
                              scoped={params.agentId !== undefined}
                              onClear={clear}
                          />
                      ),
                  })}
        />
    );
}

function ChatFilters({
    view,
    filters,
    scoped,
    onClear,
}: {
    readonly view: DataTableView;
    readonly filters: ThreadListFilters;
    /** On an agent's own list the agent filter has nothing to choose. */
    readonly scoped: boolean;
    readonly onClear: () => void;
}) {
    const { search, onChange } = filters;
    const [text, setText] = useDebouncedSearch(search.q, (q) => {
        onChange({ q });
    });
    const agentsVisible = useAllows({ permission: 'agents.read' });
    const agents = useQuery({
        ...agentListQueryOptions(useEngineApi(), AGENT_LOOK_PARAMS),
        enabled: agentsVisible && !scoped,
    });
    const agentField = filterField.entity<string>({
        id: 'agent',
        label: m.chat_filter_agent(),
        icon: <Bot className={ICON} />,
        multiple: false,
        options: (agents.data?.items ?? []).map((agent) => ({
            value: agent.id,
            label: agent.name,
            icon: (
                <AgentAvatar
                    name={agent.name}
                    agentKey={agent.id}
                    profile={agent.profile}
                    origin={agent.origin}
                    size="2xs"
                />
            ),
        })),
        value: readOneParam(search.agentId),
        onChange: (value) => {
            // An agent beyond the first page stays selected by its ID from the URL until it is removed.
            const picked = value.at(-1);
            onChange({ agentId: picked === undefined ? undefined : AgentId.safeParse(picked).data });
        },
    });
    const attentionField = filterField.enum<ChatAttention>({
        id: 'needs',
        label: m.chat_filter_attention(),
        icon: <CircleDot className={ICON} />,
        options: [{ value: 'you', label: m.chat_needs_you() }],
        value: search.needs,
        onChange: (needs) => {
            onChange({ needs });
        },
    });
    const fields: FilterBarField[] = scoped || !agentsVisible ? [attentionField] : [agentField, attentionField];
    return (
        <FilterBar
            {...view}
            label={m.chat_filters()}
            search={{ label: m.chat_search(), value: text, onChange: setText, maxLength: 256 }}
            fields={fields}
            onClear={() => {
                setText('');
                onClear();
            }}
        />
    );
}
