import type { MemberId } from '@ptbk/engine-api';

import type { MessageView } from '../../chat/message-views';
import type { TestChatState } from './test-chat-session';

/**
 * The test conversation as the chat's message rows show it. As in a chat, only a completed agent reply is rendered as
 * markdown; streamed, stopped and failed text stays plain.
 */
export function testChatViews(state: TestChatState, memberId: MemberId): MessageView[] {
    const views = state.turns.map((turn): MessageView => ({
        id: turn.id,
        role: turn.role,
        createdBy: turn.role === 'user' ? memberId : null,
        text: turn.content,
        markdown: turn.role === 'agent' && turn.state === null,
        state: turn.state,
        retry: false,
    }));
    if (state.reply !== null) {
        views.push({
            id: state.reply.id,
            role: 'agent',
            createdBy: null,
            text: state.reply.text,
            markdown: false,
            state: 'streaming',
            retry: false,
        });
    }
    return views;
}
