import type { AgentId, ChatId } from '@ptbk/engine-api';

/** A thread list: every thread, or those an agent is a member of, optionally only titles matching `q`. */
export interface ChatListParams {
    readonly agentId?: AgentId;
    readonly q?: string;
}

/** Every chat query lives under `chats`, so a reconnect of the event stream can refresh them all at once. */
export const chatKeys = {
    all: ['chats'] as const,
    lists: () => [...chatKeys.all, 'list'] as const,
    list: (params: ChatListParams) => [...chatKeys.lists(), params] as const,
    details: () => [...chatKeys.all, 'detail'] as const,
    detail: (chatId: ChatId) => [...chatKeys.details(), chatId] as const,
    entries: (chatId: ChatId) => [...chatKeys.all, 'entries', chatId] as const,
};
