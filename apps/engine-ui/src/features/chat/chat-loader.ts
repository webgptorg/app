import { ChatId } from '@ptbk/engine-api';
import { notFound } from '@tanstack/react-router';

import { classifyApiError } from '../../app/api-errors';
import type { RouterContext } from '../../app/router-context';
import { chatEntriesQueryOptions, chatQueryOptions } from './chat-queries';
import { preloadMarkdown } from './render/preload-markdown';

/**
 * Loads a thread and its newest page of entries; hovering a link to it runs this, so the thread opens without a
 * spinner. An ID that cannot exist and a 404 both read as "chat not found".
 */
export async function loadChat(context: RouterContext, rawChatId: string): Promise<void> {
    const chatId = ChatId.safeParse(rawChatId).data;
    if (chatId === undefined) {
        notFound({ throw: true });
        return;
    }
    void preloadMarkdown();
    try {
        await Promise.all([
            context.queryClient.query(chatQueryOptions(context.engineApi, chatId)),
            // A failure here shows inside the panel, with its own retry.
            context.queryClient
                .infiniteQuery(chatEntriesQueryOptions(context.engineApi, chatId))
                .catch(() => undefined),
        ]);
    } catch (error) {
        const failure = classifyApiError(error);
        if (failure.kind === 'problem' && failure.problem.status === 404) notFound({ throw: true });
        throw error;
    }
}
