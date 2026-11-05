import type { ReadChat } from '@ptbk/engine-api';
import { Badge, EmptyState, ErrorState, RelativeTime, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import type { ChatListParams } from './chat-keys';
import { chatListQueryOptions } from './chat-queries';

/** The agents in a thread, in the order they joined; the User is implied by the member reading it. */
export function threadMembers(chat: Pick<ReadChat, 'members'>): string {
    return chat.members
        .filter((member) => member.kind !== 'user')
        .map((member) => member.name)
        .join(', ');
}

/** A thread's title, else its newest words, else "Untitled". */
export function chatName(chat: Pick<ReadChat, 'title' | 'preview'>): string {
    if (chat.title.trim() !== '') return chat.title;
    if (chat.preview !== null && chat.preview.trim() !== '') return chat.preview;
    return m.chat_untitled();
}

/**
 * Needs you: an agent asked something nobody answered. Unseen questions are the stronger mark; unread alone is only a
 * count, because new messages do not by themselves ask anything of the User.
 */
export function ThreadMark({ chat }: { readonly chat: Pick<ReadChat, 'questions' | 'unread'> }) {
    if (chat.questions.length > 0) {
        const unseen = chat.questions.some((question) => !question.seen);
        return <Badge tone={unseen ? 'accent' : 'neutral'}>{m.chat_needs_you()}</Badge>;
    }
    if (chat.unread > 0) return <Badge>{m.chat_unread({ count: chat.unread })}</Badge>;
    return null;
}

/** Threads, newest first: every thread, or the ones an agent is a member of. */
export function ThreadList({ params, empty }: { readonly params: ChatListParams; readonly empty?: ReactNode }) {
    const list = useQuery(chatListQueryOptions(useEngineApi(), params));
    if (list.isPending) {
        return (
            <div aria-busy="true" className="flex flex-col gap-3">
                <span className="sr-only" role="status">
                    {m.loading()}
                </span>
                {[0, 1, 2].map((index) => (
                    <Skeleton key={index} shape="block" className="h-14 w-full" />
                ))}
            </div>
        );
    }
    if (list.isError) {
        return (
            <ErrorState
                message={m.chat_load_failed()}
                onRetry={() => {
                    void list.refetch();
                }}
                retrying={list.isFetching}
            />
        );
    }
    if (list.data.items.length === 0) {
        return (
            empty ?? (
                <EmptyState
                    icon={<MessagesSquare aria-hidden />}
                    title={m.chat_empty_title()}
                    description={m.chat_empty_body()}
                    headingLevel={2}
                />
            )
        );
    }
    return (
        <ul aria-label={m.chat_list_label()} className="flex flex-col divide-y divide-divider">
            {list.data.items.map((chat) => (
                <li key={chat.id} className="flex min-h-14 items-center gap-3 py-2">
                    <div className="flex min-w-0 flex-1 flex-col">
                        <Link to="/chats/$chatId" params={{ chatId: chat.id }} className="truncate font-medium">
                            {chatName(chat)}
                        </Link>
                        <span className="truncate text-sm text-text-muted">{threadMembers(chat)}</span>
                    </div>
                    <ThreadMark chat={chat} />
                    <RelativeTime value={new Date(chat.updatedAt)} className="shrink-0 text-sm text-text-muted" />
                </li>
            ))}
        </ul>
    );
}
