import { ChatId, MessageId } from '@ptbk/engine-api';
import type { ReadMessage } from '@ptbk/engine-api';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { entriesInOrder, mergeNewestPage, upsertEntries } from './chat-cache';
import type { EntryPages } from './chat-cache';
import { chatKeys } from './chat-keys';

const chatId = ChatId.parse('chat-1');

function message(position: number, content = `m${String(position)}`): ReadMessage {
    return {
        type: 'message',
        id: MessageId.parse(`chat-1#${String(position)}`),
        chatId,
        author: { kind: 'user', key: 'user' },
        content,
        status: 'completed',
        createdBy: null,
        phase: null,
        steps: [],
        createdAt: '2026-10-01T12:00:00Z' as ReadMessage['createdAt'],
        choices: [],
        phase: null,
        steps: [],
    };
}

/** Pages newest first, each newest first, as the engine pages them. */
function cacheWith(pages: readonly (readonly ReadMessage[])[]): QueryClient {
    const queryClient = new QueryClient();
    queryClient.setQueryData<EntryPages>(chatKeys.entries(chatId), {
        pages: pages.map((items, index) => ({
            items,
            nextCursor: index < pages.length - 1 ? `c${String(index)}` : null,
        })),
        pageParams: pages.map((_, index) => (index === 0 ? null : `c${String(index - 1)}`)),
    });
    return queryClient;
}

const ids = (queryClient: QueryClient) =>
    entriesInOrder(queryClient.getQueryData<EntryPages>(chatKeys.entries(chatId))).map(({ id }) => id);

describe('chat cache', () => {
    it('replaces a known entry in place and adds new ones as the newest', () => {
        const queryClient = cacheWith([[message(3), message(2)], [message(1)]]);
        upsertEntries(queryClient, chatId, [message(2, 'edited'), message(4), message(5)]);
        expect(ids(queryClient)).toEqual(['chat-1#1', 'chat-1#2', 'chat-1#3', 'chat-1#4', 'chat-1#5']);
        const second = entriesInOrder(queryClient.getQueryData<EntryPages>(chatKeys.entries(chatId)))[1];
        expect(second?.type === 'message' ? second.content : null).toBe('edited');
    });

    it('does nothing without a cached thread', () => {
        const queryClient = new QueryClient();
        upsertEntries(queryClient, chatId, [message(1)]);
        expect(queryClient.getQueryData(chatKeys.entries(chatId))).toBeUndefined();
    });

    it('merges an overlapping newest page and starts over when the page shares nothing', () => {
        const queryClient = cacheWith([[message(2), message(1)]]);
        mergeNewestPage(queryClient, chatId, { items: [message(4), message(3), message(2)], nextCursor: 'x' });
        expect(ids(queryClient)).toEqual(['chat-1#1', 'chat-1#2', 'chat-1#3', 'chat-1#4']);
        mergeNewestPage(queryClient, chatId, { items: [message(9), message(8)], nextCursor: 'y' });
        expect(ids(queryClient)).toEqual(['chat-1#8', 'chat-1#9']);
    });

    it('keeps a reply it saw finish finished when an earlier read still calls it streaming', () => {
        const queryClient = cacheWith([[message(2), message(1)]]);
        mergeNewestPage(queryClient, chatId, {
            items: [{ ...message(2), status: 'streaming' }, message(1)],
            nextCursor: null,
        });
        const newest = entriesInOrder(queryClient.getQueryData<EntryPages>(chatKeys.entries(chatId))).at(-1);
        expect(newest?.type === 'message' ? newest.status : null).toBe('completed');
    });

    it('fills an empty cache from the page', () => {
        const queryClient = new QueryClient();
        mergeNewestPage(queryClient, chatId, { items: [message(1)], nextCursor: null });
        expect(ids(queryClient)).toEqual(['chat-1#1']);
    });
});
