import type { ChatId, EngineApiClient } from '@ptbk/engine-api';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { chatKeys } from './chat-keys';
import type { ChatListParams } from './chat-keys';

/** Threads change through this UI or arrive as `chat.changed` events, so a short freshness window is enough. */
const CHAT_STALE_MS = 30_000;
export const ENTRY_PAGE_SIZE = 50;
export const THREAD_PAGE_SIZE = 50;

/** The newest threads first; an agent's list holds the threads it is a member of. */
export function chatListQueryOptions(engineApi: EngineApiClient, params: ChatListParams) {
    return queryOptions({
        queryKey: chatKeys.list(params),
        queryFn: async ({ signal }) =>
            unwrap(
                params.agentId === undefined
                    ? await engineApi.chats.listAll({ limit: THREAD_PAGE_SIZE }, signal)
                    : await engineApi.chats.list(params.agentId, { limit: THREAD_PAGE_SIZE }, signal),
            ),
        staleTime: CHAT_STALE_MS,
    });
}

export function chatQueryOptions(engineApi: EngineApiClient, chatId: ChatId) {
    return queryOptions({
        queryKey: chatKeys.detail(chatId),
        queryFn: async ({ signal }) => unwrap(await engineApi.chats.get(chatId, signal)),
        staleTime: CHAT_STALE_MS,
    });
}

/**
 * A thread's messages and events, newest page first, each page newest first. Reply streams and `chat.changed` events
 * write into this cache, so it never goes stale on a timer: refetching would reload every page of a long history.
 */
export function chatEntriesQueryOptions(engineApi: EngineApiClient, chatId: ChatId) {
    return infiniteQueryOptions({
        queryKey: chatKeys.entries(chatId),
        queryFn: async ({ pageParam, signal }) =>
            unwrap(
                await engineApi.chats.listEntries(
                    chatId,
                    pageParam === null ? { limit: ENTRY_PAGE_SIZE } : { limit: ENTRY_PAGE_SIZE, cursor: pageParam },
                    signal,
                ),
            ),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
    });
}
