import { ChatId, MessageId } from '@ptbk/engine-api';
import type { Message } from '@ptbk/engine-api';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { mergeNewestPage, messagesInOrder, upsertMessages } from './chat-cache';
import type { MessagePages } from './chat-cache';
import { chatKeys } from './chat-keys';

const chatId = ChatId.parse('chat-1');

function message(id: string, second: number, content = id): Message {
    return {
        id: MessageId.parse(id),
        chatId,
        role: 'user',
        content,
        status: 'completed',
        createdBy: null,
        createdAt: `2026-10-01T12:00:${String(second).padStart(2, '0')}Z` as Message['createdAt'],
    };
}

function cacheWith(pages: readonly (readonly Message[])[]): QueryClient {
    const queryClient = new QueryClient();
    queryClient.setQueryData<MessagePages>(chatKeys.messages(chatId), {
        pages: pages.map((items, index) => ({
            items,
            nextCursor: index < pages.length - 1 ? `c${String(index)}` : null,
        })),
        pageParams: pages.map((_, index) => (index === 0 ? null : `c${String(index - 1)}`)),
    });
    return queryClient;
}

const ids = (queryClient: QueryClient) =>
    messagesInOrder(queryClient.getQueryData<MessagePages>(chatKeys.messages(chatId))).map(({ id }) => id);

describe('chat cache', () => {
    it('replaces known messages where they are and adds new ones to the newest page, newest first', () => {
        const queryClient = cacheWith([[message('c', 3), message('b', 2)], [message('a', 1)]]);
        upsertMessages(queryClient, chatId, [message('a', 1, 'edited'), message('e', 5), message('d', 4)]);
        expect(ids(queryClient)).toEqual(['a', 'b', 'c', 'd', 'e']);
        const data = queryClient.getQueryData<MessagePages>(chatKeys.messages(chatId));
        expect(data?.pages[1]?.items[0]?.content).toBe('edited');
        upsertMessages(queryClient, chatId, [message('c', 3, 'again')]);
        expect(ids(queryClient)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('leaves an uncached history alone, and an empty one too', () => {
        const queryClient = new QueryClient();
        upsertMessages(queryClient, chatId, [message('a', 1)]);
        expect(queryClient.getQueryData(chatKeys.messages(chatId))).toBeUndefined();
        queryClient.setQueryData<MessagePages>(chatKeys.messages(chatId), { pages: [], pageParams: [] });
        upsertMessages(queryClient, chatId, [message('a', 1)]);
        expect(ids(queryClient)).toEqual([]);
    });

    it('merges an overlapping newest page and starts over from one that shares nothing', () => {
        const queryClient = cacheWith([[message('b', 2)], [message('a', 1)]]);
        mergeNewestPage(queryClient, chatId, { items: [message('c', 3), message('b', 2)], nextCursor: 'x' });
        expect(ids(queryClient)).toEqual(['a', 'b', 'c']);
        mergeNewestPage(queryClient, chatId, { items: [message('z', 9)], nextCursor: 'y' });
        expect(ids(queryClient)).toEqual(['z']);
        const fresh = new QueryClient();
        mergeNewestPage(fresh, chatId, { items: [message('a', 1)], nextCursor: null });
        expect(ids(fresh)).toEqual(['a']);
    });
});
