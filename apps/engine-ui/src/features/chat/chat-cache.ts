import type { ChatId, ReadChatEntry } from '@ptbk/engine-api';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { chatKeys } from './chat-keys';

export interface EntryPage {
    readonly items: readonly ReadChatEntry[];
    readonly nextCursor: string | null;
}

export type EntryPages = InfiniteData<EntryPage, string | null>;

/**
 * Puts entries the engine confirmed (a sent message, a finished reply) into the cached thread: a known ID is replaced
 * where it is, a new one joins the front of the newest page, where the newest entries are. Without a cached thread
 * there is nothing to update; the next read fetches it.
 */
export function upsertEntries(queryClient: QueryClient, chatId: ChatId, entries: readonly ReadChatEntry[]): void {
    queryClient.setQueryData<EntryPages>(chatKeys.entries(chatId), (data) => {
        if (data === undefined) return data;
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const pages = data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => {
                const replacement = byId.get(item.id);
                if (replacement === undefined) return item;
                byId.delete(item.id);
                return replacement;
            }),
        }));
        const added = [...byId.values()].toReversed();
        return {
            ...data,
            pages: pages.map((page, index) => (index === 0 ? { ...page, items: [...added, ...page.items] } : page)),
        };
    });
}

/**
 * Merges a freshly fetched newest page, whose order is the engine's. When it shares no entry with the cache, the
 * thread has moved on further than one page, so it starts over from that page instead of leaving a gap.
 */
export function mergeNewestPage(queryClient: QueryClient, chatId: ChatId, page: EntryPage): void {
    queryClient.setQueryData<EntryPages>(chatKeys.entries(chatId), (data) => {
        const fresh = new Set(page.items.map((item) => item.id));
        const known = new Set(data?.pages.flatMap((cached) => cached.items.map((item) => item.id)));
        const overlaps = page.items.some((item) => known.has(item.id));
        if (data === undefined || (!overlaps && page.items.length > 0 && known.size > 0)) {
            return { pages: [page], pageParams: [null] };
        }
        const cached = new Map(data.pages.flatMap((cachedPage) => cachedPage.items.map((item) => [item.id, item])));
        // A reply this panel saw finish stays finished: a page read a moment earlier may still call it streaming.
        const items = page.items.map((item) => {
            const known = cached.get(item.id);
            return item.type === 'message' &&
                item.status === 'streaming' &&
                known?.type === 'message' &&
                known.status !== 'streaming'
                ? known
                : item;
        });
        // The fresh page replaces the cached newest page's overlap; older entries of that page stay after it.
        return {
            ...data,
            pages: data.pages.map((cachedPage, index) =>
                index === 0
                    ? { ...cachedPage, items: [...items, ...cachedPage.items.filter((item) => !fresh.has(item.id))] }
                    : cachedPage,
            ),
        };
    });
}

/** Oldest first, as the thread reads. */
export function entriesInOrder(data: InfiniteData<EntryPage> | undefined): ReadChatEntry[] {
    return (data?.pages ?? []).flatMap((page) => page.items).toReversed();
}
