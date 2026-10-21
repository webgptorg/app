import type { AgentChatListQuery, AgentId, ChatId } from '@ptbk/engine-api';
import type { z } from 'zod';

export type ChatListParams = z.input<typeof AgentChatListQuery>;

/** Every chat query lives under `chats`, so a reconnect of the event stream can refresh them all at once. */
export const chatKeys = {
    all: ['chats'] as const,
    lists: () => [...chatKeys.all, 'list'] as const,
    list: (agentId: AgentId, params: ChatListParams) => [...chatKeys.lists(), agentId, params] as const,
    details: () => [...chatKeys.all, 'detail'] as const,
    detail: (chatId: ChatId) => [...chatKeys.details(), chatId] as const,
    messages: (chatId: ChatId) => [...chatKeys.all, 'messages', chatId] as const,
};
