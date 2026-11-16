import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';

import { m } from '../../paraglide/messages';
import { Page } from '../shell/page';
import type { ChatSearch } from './chat-search';
import { NewChatActions } from './new-chat-actions';
import { ThreadList } from './thread-list';

const route = getRouteApi('/chats/');

/** Every thread on the engine: with you, between agents, and the engine's report. Threads that need you say so. */
export function ThreadsPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const onChange = useCallback(
        (change: Partial<ChatSearch>) => {
            void navigate({ search: (previous) => ({ ...previous, ...change }) });
        },
        [navigate],
    );
    return (
        <Page title={m.nav_chats()} description={m.chat_intro()} actions={<NewChatActions />}>
            <ThreadList params={{}} filters={{ search, onChange }} />
        </Page>
    );
}
