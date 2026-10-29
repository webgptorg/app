import { AgentId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { chatListParams, ChatListSearch } from '../../../../features/chat/chat-list-search';
import { chatListQueryOptions } from '../../../../features/chat/chat-queries';
import { ChatTablePage } from '../../../../features/chat/chat-table-page';

// The static segment outranks `$chatId`: a chat whose opaque ID were literally "all" would not open here.
export const Route = createFileRoute('/agents/$agentId/chat/all')({
    validateSearch: ChatListSearch,
    loaderDeps: ({ search }) => chatListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads (keepPreviousData).
    loader: ({ context, params, deps }) => {
        const agentId = AgentId.safeParse(params.agentId).data;
        if (agentId === undefined) return;
        // A failure shows in the table (with retry) once the component's own query sees it.
        context.queryClient.query(chatListQueryOptions(context.engineApi, agentId, deps)).catch(() => undefined);
    },
    component: ChatTablePage,
});
