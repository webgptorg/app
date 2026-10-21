import { AgentId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { ChatListPage } from '../../../../features/chat/chat-list-page';
import { chatListParams, ChatListSearch } from '../../../../features/chat/chat-list-search';
import { chatListQueryOptions } from '../../../../features/chat/chat-queries';

export const Route = createFileRoute('/agents/$agentId/chat/')({
    validateSearch: ChatListSearch,
    loaderDeps: ({ search }) => chatListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads (keepPreviousData).
    loader: ({ context, params, deps }) => {
        const agentId = AgentId.safeParse(params.agentId).data;
        if (agentId === undefined) return;
        // A failure shows in the table (with retry) once the component's own query sees it.
        context.queryClient.query(chatListQueryOptions(context.engineApi, agentId, deps)).catch(() => undefined);
    },
    component: ChatListPage,
});
