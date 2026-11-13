import type { MemberId } from '@ptbk/engine-api';

import type { MessageView } from '../../chat/message-views';
import type { TestChatState } from './test-chat-session';

const USER = { kind: 'user', key: 'user' } as const;

/**
 * The test conversation as a chat's message rows show it: the member and the draft agent. As in a chat, only a
 * completed agent reply is rendered as markdown.
 */
export function testChatViews(state: TestChatState, memberId: MemberId, agentName: string): MessageView[] {
    const row = (id: string, role: 'user' | 'agent', text: string, state: MessageView['state']): MessageView => ({
        kind: 'message',
        id,
        author: role === 'user' ? USER : { kind: 'agent', key: 'draft' },
        authorName: role === 'user' ? '' : agentName,
        createdBy: role === 'user' ? memberId : null,
        createdAt: null,
        text,
        markdown: role === 'agent' && state === null,
        state,
        retry: false,
        question: null,
        choices: [],
    });
    const views = state.turns.map((turn) => row(turn.id, turn.role, turn.content, turn.state));
    if (state.reply !== null) views.push(row(state.reply.id, 'agent', state.reply.text, 'streaming'));
    return views;
}
