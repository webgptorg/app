import { createFileRoute } from '@tanstack/react-router';

import { chatListQueryOptions } from '../../features/chat/chat-queries';
import { ThreadsPage } from '../../features/chat/threads-page';

export const Route = createFileRoute('/chats/')({
    // Not awaited: the list shows its own skeleton and error.
    loader: ({ context }) => {
        context.queryClient.query(chatListQueryOptions(context.engineApi, {})).catch(() => undefined);
    },
    component: ThreadsPage,
});
