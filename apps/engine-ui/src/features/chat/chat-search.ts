import { AgentId } from '@ptbk/engine-api';
import type { ReadChat } from '@ptbk/engine-api';
import { z } from 'zod';

import type { ChatListParams } from './chat-keys';

const MAX_SEARCH_LENGTH = 256;
const CHAT_ATTENTION = ['you'] as const;
export type ChatAttention = (typeof CHAT_ATTENTION)[number];

/** The chat list's filters in the URL, so a filtered view links and survives a reload; bad values mean no filter. */
export const ChatSearch = z.object({
    q: z.string().trim().min(1).max(MAX_SEARCH_LENGTH).optional().catch(undefined),
    agentId: AgentId.optional().catch(undefined),
    needs: z.enum(CHAT_ATTENTION).optional().catch(undefined),
});
export type ChatSearch = z.output<typeof ChatSearch>;

export const NO_CHAT_FILTERS = { q: undefined, agentId: undefined, needs: undefined } as const;

export function hasChatFilters(search: ChatSearch): boolean {
    return search.q !== undefined || search.agentId !== undefined || search.needs !== undefined;
}

/** The engine filters by title and by agent; "needs you" is read from each thread's open questions. */
export function chatListParams(search: ChatSearch): ChatListParams {
    return {
        ...(search.agentId === undefined ? {} : { agentId: search.agentId }),
        ...(search.q === undefined ? {} : { q: search.q }),
    };
}

export function needsYou(chat: Pick<ReadChat, 'questions'>): boolean {
    return chat.questions.length > 0;
}
