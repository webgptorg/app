import { redirect } from '@tanstack/react-router';

import { loadAccess } from '../../app/registry/engine-access';
import type { RouterContext } from '../../app/router-context';
import type { ChatListSearch } from './chat-list-search';

/**
 * For the Chat tab's index: a member who cannot write has no fresh conversation to start, so they get the table of
 * chats. So does a link from before the table moved to `all` (it carries the table's filter or cursor).
 */
export async function redirectToChatTable({
    context,
    params,
    search,
}: {
    readonly context: RouterContext;
    readonly params: { readonly agentId: string };
    readonly search: ChatListSearch;
}): Promise<void> {
    const tableLink = search.source !== undefined || search.cursor !== undefined;
    if (!tableLink && (await loadAccess(context)).can('chats.write')) return;
    redirect({ to: '/agents/$agentId/chat/all', params, search, replace: true, throw: true });
}
