import type { AgentId } from '@ptbk/engine-api';
import { Button, Drawer, RelativeTime, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { List, MessagesSquare, SquarePen } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { chatListQueryOptions } from './chat-queries';
import { chatName } from './chat-source';

const ROW = cx(
    'flex min-w-0 rounded-control px-3 text-sm text-text no-underline hover:bg-hover',
    'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
    'aria-[current=page]:bg-selected aria-[current=page]:text-accent-text',
);

interface RecentChatsProps {
    readonly agentId: AgentId;
    /** After a link is followed, e.g. to close the drawer it sits in. */
    readonly onNavigate?: () => void;
}

/**
 * The agent's latest chats as navigation: "New chat", the first page of the chat list (the table's own cache entry,
 * so "All chats" opens without a fetch) and "All chats". Members who may only read still get it, minus "New chat".
 */
export function RecentChats({ agentId, onNavigate }: RecentChatsProps) {
    const engineApi = useEngineApi();
    const { can } = usePermissions();
    const list = useQuery(chatListQueryOptions(engineApi, agentId, {}));

    let rows: ReactNode;
    if (list.isPending) {
        rows = (
            <div aria-hidden="true" className="flex flex-col gap-3 px-3 py-2">
                {[0, 1, 2, 3].map((index) => (
                    <Skeleton key={index} shape="text" className="h-4 w-4/5" />
                ))}
            </div>
        );
    } else if (list.isError) {
        rows = (
            <div role="alert" className="flex flex-col items-start gap-2 px-3 py-2 text-sm text-text-muted">
                {m.chat_load_failed()}
                <Button
                    size="sm"
                    variant="ghost"
                    loading={list.isFetching}
                    onClick={() => {
                        void list.refetch();
                    }}
                >
                    {m.error_retry()}
                </Button>
            </div>
        );
    } else if (list.data.items.length === 0) {
        rows = <p className="px-3 py-2 text-sm text-text-muted">{m.chat_empty_title()}</p>;
    } else {
        rows = (
            <ul className="flex flex-col gap-0.5">
                {list.data.items.map((chat) => (
                    <li key={chat.id}>
                        <Link
                            to="/agents/$agentId/chat/$chatId"
                            params={{ agentId, chatId: chat.id }}
                            activeOptions={{ exact: true }}
                            variant="standalone"
                            onClick={onNavigate}
                            className={cx(ROW, 'flex-col py-1.5')}
                        >
                            <span className="truncate">{chatName(chat)}</span>
                            <RelativeTime
                                value={new Date(chat.lastMessageAt ?? chat.updatedAt)}
                                className="text-xs text-text-muted"
                            />
                        </Link>
                    </li>
                ))}
            </ul>
        );
    }

    return (
        <nav aria-label={m.chat_recent_label()} className="flex min-h-0 flex-1 flex-col gap-3">
            {can('chats.write') ? (
                <Link
                    to="/agents/$agentId/chat"
                    params={{ agentId }}
                    activeOptions={{ exact: true }}
                    variant="standalone"
                    onClick={onNavigate}
                    className={cx(ROW, 'min-h-10 items-center gap-2 font-medium')}
                >
                    <SquarePen aria-hidden className="size-4 shrink-0" />
                    {m.chat_new_label()}
                </Link>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col gap-1">
                <p aria-hidden="true" className="px-3 text-xs font-semibold tracking-wide text-text-muted uppercase">
                    {m.chat_recent_heading()}
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto">{rows}</div>
            </div>
            <Link
                to="/agents/$agentId/chat/all"
                params={{ agentId }}
                variant="standalone"
                onClick={onNavigate}
                className={cx(ROW, 'min-h-10 items-center gap-2 font-medium')}
            >
                <List aria-hidden className="size-4 shrink-0" />
                {m.chat_back()}
            </Link>
        </nav>
    );
}

/** Opens the recent list in a drawer where the chat area is too narrow for it to sit beside the conversation. */
export function RecentChatsButton({ agentId, className }: { readonly agentId: AgentId; readonly className?: string }) {
    const [open, setOpen] = useState(false);
    const close = () => {
        setOpen(false);
    };
    return (
        <>
            <Button
                size="sm"
                variant="secondary"
                aria-expanded={open}
                onClick={() => {
                    setOpen(true);
                }}
                {...(className === undefined ? {} : { className })}
            >
                <MessagesSquare aria-hidden className="size-4" />
                {m.chat_drawer()}
            </Button>
            <Drawer open={open} onClose={close} title={m.chat_drawer()} side="start">
                <RecentChats agentId={agentId} onNavigate={close} />
            </Drawer>
        </>
    );
}

/**
 * A conversation (or the fresh one) with the recent list beside it once the Chat tab's panel is wide enough. A
 * container query rather than a breakpoint: the shell's sidebar, expanded or not, decides how much room is left.
 */
export function WithRecentChats({ agentId, children }: { readonly agentId: AgentId; readonly children: ReactNode }) {
    return (
        <div className="@container flex min-h-0 min-w-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 gap-6">
                <div className="hidden w-60 shrink-0 flex-col @2xl:flex">
                    <RecentChats agentId={agentId} />
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
            </div>
        </div>
    );
}
