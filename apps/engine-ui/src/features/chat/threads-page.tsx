import { m } from '../../paraglide/messages';
import { Page } from '../shell/page';
import { NewChatActions } from './new-chat-actions';
import { ThreadList } from './thread-list';

/** Every thread on the engine: with you, between agents, and the engine's report. Threads that need you say so. */
export function ThreadsPage() {
    return (
        <Page title={m.nav_chats()} description={m.chat_intro()} actions={<NewChatActions />}>
            <ThreadList params={{}} />
        </Page>
    );
}
