import { ChatId } from '@ptbk/engine-api';
import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { useDocumentTitle } from '../shell/document-title';
import { BackLink } from '../shell/page';
import { usePermissions } from '../session/use-permissions';
import { ChatPanel } from './chat-panel';
import { chatQueryOptions } from './chat-queries';
import { chatName, threadMembers } from './thread-list';

const route = getRouteApi('/chats/$chatId');

/**
 * One thread: its title (which changes with the topic), who is in it, and the conversation. Any member who may write
 * writes in any thread; nobody owns one.
 */
export function ThreadPage() {
    const chatId = ChatId.parse(route.useParams({ select: (params) => params.chatId }));
    const { data: chat } = useSuspenseQuery(chatQueryOptions(useEngineApi(), chatId));
    const { can } = usePermissions();
    const title = chatName(chat);
    useDocumentTitle(title, m.nav_chats());

    // The page takes the rest of the screen, so the composer is in view without scrolling.
    return (
        <section
            aria-labelledby="page-title"
            className="flex h-(--main-fill-height) min-h-[30rem] min-w-0 flex-col gap-2"
        >
            <div className="flex">
                <BackLink to="/chats">{m.chat_back()}</BackLink>
            </div>
            <header className="flex min-w-0 flex-col">
                <h1 id="page-title" className="truncate text-lg font-semibold">
                    {title}
                </h1>
                <p className="truncate text-sm text-text-muted">{threadMembers(chat)}</p>
            </header>
            {/* Keyed: the stream, the draft and the scroll position belong to one thread, not to the route. */}
            <ChatPanel key={chat.id} chat={chat} canWrite={can('chats.write')} fill />
        </section>
    );
}
