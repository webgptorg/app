import { ChatId, MemberId, MessageId } from '@ptbk/engine-api';
import type { Message } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { INITIAL_CHAT_SESSION } from './chat-session';
import type { ChatSessionState } from './chat-session';
import { messageViews } from './message-views';

const me = MemberId.parse('member-owner');
const chatId = ChatId.parse('chat-1');

function message(id: string, fields: Partial<Message> = {}): Message {
    return {
        id: MessageId.parse(id),
        chatId,
        role: 'agent',
        content: `Text of ${id}`,
        status: 'completed',
        createdBy: null,
        createdAt: '2026-10-01T12:00:00Z' as Message['createdAt'],
        ...fields,
    };
}

const session = (fields: Partial<ChatSessionState>): ChatSessionState => ({ ...INITIAL_CHAT_SESSION, ...fields });
const options = { memberId: me, canSendAgain: true };

describe('messageViews', () => {
    it('renders only completed agent replies as markdown and labels stored states', () => {
        const views = messageViews(
            [
                message('u', { role: 'user', createdBy: me }),
                message('a'),
                message('s', { status: 'cancelled', content: '' }),
                message('f', { status: 'failed' }),
                message('g', { status: 'streaming' }),
            ],
            INITIAL_CHAT_SESSION,
            options,
        );
        expect(views.map(({ id, markdown, state }) => [id, markdown, state])).toEqual([
            ['u', false, null],
            ['a', true, null],
            ['s', false, 'stopped'],
            ['f', false, 'failed'],
            ['g', false, 'streaming'],
        ]);
        expect(views[2]?.text).toBe('');
    });

    it('shows the streamed text over the reply’s row, or after the history until the engine has it', () => {
        const followed = session({
            phase: 'streaming',
            reply: { messageId: MessageId.parse('r'), text: 'Live', lastSeq: 1 },
        });
        const inHistory = messageViews([message('r', { status: 'streaming', content: '' })], followed, options);
        expect(inHistory).toEqual([
            expect.objectContaining({ id: 'r', text: 'Live', state: 'streaming', markdown: false }),
        ]);
        const appended = messageViews([message('u', { role: 'user' })], followed, options);
        expect(appended.map(({ id }) => id)).toEqual(['u', 'r']);
    });

    it('prefers the engine’s copy once the stream is gone, and offers retry by state', () => {
        const reply = { messageId: MessageId.parse('r'), text: 'Partial', lastSeq: 1 };
        const interrupted = messageViews(
            [message('r', { status: 'streaming', content: '' })],
            session({ phase: 'interrupted', reply }),
            options,
        );
        expect(interrupted[0]).toMatchObject({ text: 'Partial', state: 'interrupted', retry: true });
        const failed = messageViews(
            [message('r', { status: 'failed', content: 'Full text' })],
            session({ phase: 'error', reply }),
            options,
        );
        expect(failed[0]).toMatchObject({ text: 'Full text', state: 'failed', retry: true });
        const readOnly = messageViews([message('r', { status: 'failed' })], session({ phase: 'error', reply }), {
            ...options,
            canSendAgain: false,
        });
        expect(readOnly[0]?.retry).toBe(false);
    });

    it('keeps the partial text of a stopped reply the engine kept empty, and shows the message being sent', () => {
        const views = messageViews(
            [message('s', { status: 'cancelled', content: '' })],
            session({ partials: new Map([['s', 'Kept']]), outgoing: 'Sending this' }),
            options,
        );
        expect(views[0]).toMatchObject({ text: 'Kept', state: 'stopped' });
        expect(views[1]).toMatchObject({ role: 'user', createdBy: me, text: 'Sending this', state: 'pending' });
    });
});
