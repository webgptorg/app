import type { ReadChat } from '@ptbk/engine-api';
import { EmptyState, RelativeTime, Section, Skeleton, StatusDot } from '@ptbk/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { useEngineApi } from '../../app/engine-api-context';
import { chatEntriesQueryOptions } from '../chat/chat-queries';
import { ChatAvatars } from '../chat/chat-avatars';
import { chatName } from '../chat/chat-name';
import { chatPreview } from './chat-preview';

export const RECENT_CHAT_COUNT = 6;

/** One thread as a rich row: its agents, title, a calm preview (never step text) and when it last moved. */
export function ChatRow({ chat }: { readonly chat: ReadChat }) {
    // Only what the thread already has in the cache: Home never fetches every thread's entries for a preview.
    const cached = useInfiniteQuery({ ...chatEntriesQueryOptions(useEngineApi(), chat.id), enabled: false }).data;
    const preview = chatPreview(
        chat,
        cached?.pages.flatMap((page) => page.items),
    );
    const waiting = chat.questions.length > 0;
    const unread = chat.unread > 0;
    return (
        <li>
            <Link
                to="/chats/$chatId"
                params={{ chatId: chat.id }}
                variant="standalone"
                className="-mx-2 flex min-h-12 items-center gap-3 rounded-control px-2 py-2 text-text no-underline hover:bg-hover hover:no-underline"
            >
                <ChatAvatars chat={chat} />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{chatName(chat)}</span>
                        {waiting ? (
                            <StatusDot tone="warning" label={m.chat_needs_you()} />
                        ) : unread ? (
                            <StatusDot tone="info" label={m.chat_unread({ count: chat.unread })} />
                        ) : null}
                    </span>
                    {preview === null ? null : preview.kind === 'working' ? (
                        <span className="truncate text-xs text-text-muted italic">{m.home_chat_working()}</span>
                    ) : (
                        <span className="truncate text-xs text-text-muted">{preview.text}</span>
                    )}
                </span>
                <RelativeTime
                    value={new Date(chat.lastMessageAt ?? chat.updatedAt)}
                    className="shrink-0 text-xs text-text-muted tabular-nums"
                />
            </Link>
        </li>
    );
}

/** The newest threads, with who is in them and their latest words; one quiet line before the first. */
export function RecentChats({
    chats,
    failed,
}: {
    readonly chats: readonly ReadChat[] | undefined;
    readonly failed: boolean;
}) {
    return (
        <Section
            title={m.home_recent_chats()}
            actions={
                <Link to="/chats" variant="standalone" className="text-xs text-text-muted">
                    {m.home_all_chats()}
                </Link>
            }
        >
            {chats === undefined ? (
                failed ? (
                    <p className="text-sm text-text-muted">{m.home_widget_failed()}</p>
                ) : (
                    <div aria-busy="true" className="flex flex-col gap-2">
                        {[0, 1, 2].map((row) => (
                            <Skeleton key={row} className="h-10 w-full" />
                        ))}
                    </div>
                )
            ) : chats.length === 0 ? (
                <EmptyState
                    variant="inline"
                    headingLevel={3}
                    icon={<MessageSquare aria-hidden />}
                    title={m.home_recent_chats_empty_body()}
                />
            ) : (
                <ul className="flex flex-col">
                    {chats.slice(0, RECENT_CHAT_COUNT).map((chat) => (
                        <ChatRow key={chat.id} chat={chat} />
                    ))}
                </ul>
            )}
        </Section>
    );
}
