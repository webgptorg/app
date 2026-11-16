import { createFileRoute } from '@tanstack/react-router';

import { chatListQueryOptions } from '../../features/chat/chat-queries';
import { ChatSearch, chatListParams } from '../../features/chat/chat-search';
import { ThreadsPage } from '../../features/chat/threads-page';

export const Route = createFileRoute('/chats/')({
    validateSearch: ChatSearch,
    loaderDeps: ({ search }) => chatListParams(search),
    // Not awaited: the list shows its own skeleton and error.
    loader: ({ context, deps }) => {
        context.queryClient.query(chatListQueryOptions(context.engineApi, deps)).catch(() => undefined);
    },
    component: ThreadsPage,
});
