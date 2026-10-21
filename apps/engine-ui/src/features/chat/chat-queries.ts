import type { AgentId, ChatId, EngineApiClient } from '@ptbk/engine-api';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { chatKeys } from './chat-keys';
import type { ChatListParams } from './chat-keys';

/** Chats change through this UI or arrive as `chat.changed` events, so a short freshness window is enough. */
const CHAT_STALE_MS = 30_000;
export const MESSAGE_PAGE_SIZE = 50;

export function chatListQueryOptions(engineApi: EngineApiClient, agentId: AgentId, params: ChatListParams) {
    return queryOptions({
        queryKey: chatKeys.list(agentId, params),
        queryFn: async ({ signal }) => unwrap(await engineApi.chats.list(agentId, params, signal)),
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
 * A chat's messages, newest page first, each page newest first. Reply streams and `chat.changed` events write into
 * this cache, so it never goes stale on a timer: refetching would reload every page of a long history.
 */
export function chatMessagesQueryOptions(engineApi: EngineApiClient, chatId: ChatId) {
    return infiniteQueryOptions({
        queryKey: chatKeys.messages(chatId),
        queryFn: async ({ pageParam, signal }) =>
            unwrap(
                await engineApi.chats.listMessages(
                    chatId,
                    pageParam === null ? { limit: MESSAGE_PAGE_SIZE } : { limit: MESSAGE_PAGE_SIZE, cursor: pageParam },
                    signal,
                ),
            ),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
    });
}
