import { AgentId, ChatId } from '@ptbk/engine-api';
import { notFound } from '@tanstack/react-router';

import { classifyApiError } from '../../app/api-errors';
import type { RouterContext } from '../../app/router-context';
import { chatMessagesQueryOptions, chatQueryOptions } from './chat-queries';
import { preloadMarkdown } from './render/lazy-markdown';

/**
 * Loads a chat and its newest page of messages; hovering a link to it runs this, so the chat opens without a
 * spinner. An ID that cannot exist, a 404 and a chat of another agent all read as "chat not found".
 */
export async function loadChat(context: RouterContext, rawAgentId: string, rawChatId: string): Promise<void> {
    const agentId = AgentId.safeParse(rawAgentId).data;
    const chatId = ChatId.safeParse(rawChatId).data;
    if (agentId === undefined || chatId === undefined) {
        notFound({ throw: true });
        return;
    }
    void preloadMarkdown();
    try {
        const [chat] = await Promise.all([
            context.queryClient.query(chatQueryOptions(context.engineApi, chatId)),
            // A failure here shows inside the panel, with its own retry.
            context.queryClient
                .infiniteQuery(chatMessagesQueryOptions(context.engineApi, chatId))
                .catch(() => undefined),
        ]);
        if (chat.agentId !== agentId) notFound({ throw: true });
    } catch (error) {
        const failure = classifyApiError(error);
        if (failure.kind === 'problem' && failure.problem.status === 404) notFound({ throw: true });
        throw error;
    }
}
