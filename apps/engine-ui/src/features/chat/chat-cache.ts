import type { ChatId, Message } from '@ptbk/engine-api';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { chatKeys } from './chat-keys';

export interface MessagePage {
    readonly items: readonly Message[];
    readonly nextCursor: string | null;
}

export type MessagePages = InfiniteData<MessagePage, string | null>;

const newestFirst = (a: Message, b: Message): number =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);

/**
 * Puts messages the engine confirmed (a sent message, a finished reply) into the cached history: a known ID is
 * replaced where it is, a new one joins the newest page. Without a cached history there is nothing to update; the
 * next read fetches it.
 */
export function upsertMessages(queryClient: QueryClient, chatId: ChatId, messages: readonly Message[]): void {
    queryClient.setQueryData<MessagePages>(chatKeys.messages(chatId), (data) => {
        if (data === undefined) return data;
        const byId = new Map(messages.map((message) => [message.id, message]));
        const pages = data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => {
                const replacement = byId.get(item.id);
                if (replacement === undefined) return item;
                byId.delete(item.id);
                return replacement;
            }),
        }));
        const [first, ...rest] = pages;
        if (first === undefined) return data;
        const added = [...byId.values()];
        if (added.length === 0) return { ...data, pages };
        return { ...data, pages: [{ ...first, items: [...added, ...first.items].sort(newestFirst) }, ...rest] };
    });
}

/**
 * Merges a freshly fetched newest page. When it shares no message with the cache, the history has moved on further
 * than one page, so it starts over from that page instead of leaving a gap.
 */
export function mergeNewestPage(queryClient: QueryClient, chatId: ChatId, page: MessagePage): void {
    const data = queryClient.getQueryData<MessagePages>(chatKeys.messages(chatId));
    const known = new Set(data?.pages.flatMap((cached) => cached.items.map((item) => item.id)));
    const overlaps = page.items.some((item) => known.has(item.id));
    if (data === undefined || (!overlaps && page.items.length > 0 && known.size > 0)) {
        queryClient.setQueryData<MessagePages>(chatKeys.messages(chatId), { pages: [page], pageParams: [null] });
        return;
    }
    upsertMessages(queryClient, chatId, page.items);
}

/** Oldest first, as the conversation reads. */
export function messagesInOrder(data: InfiniteData<MessagePage> | undefined): Message[] {
    return (data?.pages ?? []).flatMap((page) => page.items).toReversed();
}
