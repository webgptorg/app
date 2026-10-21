import type { ReadChat } from '@ptbk/engine-api';

import { m } from '../../paraglide/messages';
import { AgentCreator } from '../agents/agent-creator';

/**
 * Who started a chat: a member by name (or "You"), a public visitor of a public agent, or nobody in particular for
 * chats the engine or an API client opened.
 */
export function ChatStarter({ chat }: { readonly chat: Pick<ReadChat, 'createdBy' | 'source'> }) {
    if (chat.createdBy !== null) return <AgentCreator memberId={chat.createdBy} />;
    if (chat.source === 'web') return <span>{m.chat_started_by_visitor()}</span>;
    return <span aria-hidden="true">{'—'}</span>;
}
