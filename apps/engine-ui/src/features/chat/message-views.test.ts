import { ChatId, MemberId, MessageId } from '@ptbk/engine-api';
import type { ReadChat, ReadChatEntry, ReadMessage } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { INITIAL_CHAT_SESSION } from './chat-session';
import type { ChatSessionState } from './chat-session';
import { participantName, threadViews } from './message-views';

const me = MemberId.parse('member-owner');
const chatId = ChatId.parse('Thread — 2026-10-01 12:00:00');
const at = '2026-10-01T12:00:00Z' as ReadMessage['createdAt'];
const ADA = { kind: 'agent', key: 'agent-ada' } as const;
const USER = { kind: 'user', key: 'user' } as const;

function message(position: number, fields: Partial<ReadMessage> = {}): ReadMessage {
    return {
        type: 'message',
        id: MessageId.parse(`${chatId}#${String(position)}`),
        chatId,
        author: ADA,
        content: `Text ${String(position)}`,
        status: 'completed',
        createdBy: null,
        createdAt: at,
        choices: [],
        phase: null,
        steps: [],
        ...fields,
    };
}

const chat: Pick<ReadChat, 'members' | 'questions'> = {
    members: [
        { kind: 'user', key: 'user', name: 'User' },
        { kind: 'agent', key: 'agent-ada', name: 'Ada' },
    ],
    questions: [],
};
const session = (fields: Partial<ChatSessionState>): ChatSessionState => ({ ...INITIAL_CHAT_SESSION, ...fields });
const options = { memberId: me, canSendAgain: true };

describe('threadViews', () => {
    it('names authors, shows agents joining and new titles, and hides the User joining', () => {
        const entries: ReadChatEntry[] = [
            { type: 'joined', id: 'j1', chatId, createdAt: at, participant: { ...USER, name: 'User' } },
            { type: 'joined', id: 'j2', chatId, createdAt: at, participant: { ...ADA, name: 'Ada' } },
            message(1, { author: USER, createdBy: me }),
            { type: 'titled', id: 't1', chatId, createdAt: at, title: 'Billing' },
            { type: 'status', id: 's1', chatId, createdAt: at, status: 'open' },
            { type: 'status', id: 's2', chatId, createdAt: at, status: 'resolved' },
            message(2),
        ];
        const views = threadViews(chat, entries, INITIAL_CHAT_SESSION, options);
        expect(views.map((view) => (view.kind === 'event' ? view.text : `${view.authorName}|${view.text}`))).toEqual([
            'Ada joined',
            '|Text 1',
            'Renamed to “Billing”',
            'Marked as resolved',
            'Ada|Text 2',
        ]);
    });

    it('labels stored states and lays the followed reply’s live text over its row', () => {
        const views = threadViews(
            chat,
            [
                message(1, { status: 'cancelled', content: '' }),
                message(2, { status: 'failed' }),
                message(3, { status: 'streaming', content: '' }),
            ],
            session({
                phase: 'interrupted',
                reply: { messageId: message(3).id, text: 'partial', lastSeq: 2 },
                partials: new Map([[message(1).id, 'kept']]),
            }),
            options,
        );
        expect(
            views.map((view) => (view.kind === 'message' ? [view.state, view.text, view.retry, view.markdown] : null)),
        ).toEqual([
            ['stopped', 'kept', false, false],
            ['failed', 'Text 2', false, false],
            ['interrupted', 'partial', true, false],
        ]);
        const done = threadViews(chat, [message(4), message(5, { author: USER })], INITIAL_CHAT_SESSION, options);
        expect(done.map((view) => view.kind === 'message' && view.markdown)).toEqual([true, false]);
        const later = threadViews(chat, [message(6, { status: 'unknown' })], INITIAL_CHAT_SESSION, options);
        expect(later.map((view) => (view.kind === 'message' ? [view.state, view.text, view.markdown] : null))).toEqual([
            [null, 'Text 6', false],
        ]);
    });

    it('marks outstanding questions with their choices, and shows the message being sent', () => {
        const question = message(1, { choices: ['Yes', 'No'] });
        const views = threadViews(
            { ...chat, questions: [{ id: 'q', messageId: question.id, author: ADA, seen: false }] },
            [question, message(2, { choices: ['Ignored'] })],
            session({ phase: 'unconfirmed', outgoing: 'Yes' }),
            options,
        );
        expect(
            views.map((view) => (view.kind === 'message' ? [view.question, view.choices, view.state] : null)),
        ).toEqual([
            [{ seen: false }, ['Yes', 'No'], null],
            [null, [], null],
            [null, [], 'unconfirmed'],
        ]);
    });

    it('falls back to the key for a participant the thread does not list', () => {
        expect(participantName(chat, { kind: 'agent', key: 'agent-gone' })).toBe('agent-gone');
    });
});
