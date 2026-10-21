import { MessageId } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { chatSessionReducer, INITIAL_CHAT_SESSION, isReplyActive } from './chat-session';
import type { ChatSessionAction, ChatSessionState } from './chat-session';

const reply = MessageId.parse('reply-1');
const other = MessageId.parse('reply-2');

function run(...actions: readonly ChatSessionAction[]): ChatSessionState {
    return actions.reduce(chatSessionReducer, INITIAL_CHAT_SESSION);
}

const streaming = (): ChatSessionAction[] => [
    { type: 'send', content: 'Hi' },
    { type: 'sent', replyMessageId: reply },
];

describe('chatSessionReducer', () => {
    it('sends, streams deltas in seq order and completes', () => {
        const sending = run({ type: 'send', content: 'Hi' });
        expect(sending).toMatchObject({ phase: 'sending', outgoing: 'Hi', lastSent: 'Hi' });
        const state = run(
            ...streaming(),
            { type: 'delta', messageId: reply, seq: 1, text: 'He' },
            { type: 'delta', messageId: reply, seq: 1, text: 'He' },
            { type: 'delta', messageId: other, seq: 2, text: '??' },
            { type: 'delta', messageId: reply, seq: 2, text: 'llo' },
        );
        expect(state).toMatchObject({ phase: 'streaming', outgoing: null, reply: { text: 'Hello', lastSeq: 2 } });
        const done = chatSessionReducer(state, { type: 'completed', messageId: reply });
        expect(done).toMatchObject({ phase: 'done', reply: null, completedCount: 1 });
        expect(chatSessionReducer(state, { type: 'completed', messageId: other })).toBe(state);
    });

    it('refuses a second send while a reply is active, and restores idle when a send fails', () => {
        const sending = run({ type: 'send', content: 'Hi' });
        expect(chatSessionReducer(sending, { type: 'send', content: 'Again' })).toBe(sending);
        expect(chatSessionReducer(sending, { type: 'follow', messageId: other })).toBe(sending);
        expect(run({ type: 'send', content: 'Hi' }, { type: 'send-failed' })).toMatchObject({
            phase: 'idle',
            outgoing: null,
        });
    });

    it('stops once, keeping the partial text', () => {
        const partial = run(...streaming(), { type: 'delta', messageId: reply, seq: 1, text: 'Part' });
        const stopping = chatSessionReducer(partial, { type: 'stop' });
        expect(stopping.phase).toBe('stopping');
        expect(chatSessionReducer(stopping, { type: 'stop' })).toBe(stopping);
        const stopped = chatSessionReducer(stopping, { type: 'stopped' });
        expect(stopped).toMatchObject({ phase: 'done', reply: null });
        expect(stopped.partials.get(reply)).toBe('Part');
        expect(chatSessionReducer(stopped, { type: 'stopped' })).toBe(stopped);
        expect(chatSessionReducer(stopping, { type: 'cancel-failed' }).phase).toBe('interrupted');
        expect(chatSessionReducer(stopped, { type: 'cancel-failed' })).toBe(stopped);
        expect(run(...streaming(), { type: 'stop' }, { type: 'stopped' }).partials.size).toBe(0);
    });

    it('marks a dropped stream interrupted, resumes it, and settles it when the engine finished it', () => {
        const partial = run(...streaming(), { type: 'delta', messageId: reply, seq: 1, text: 'Part' });
        const dropped = chatSessionReducer(partial, { type: 'dropped', messageId: reply });
        expect(dropped.phase).toBe('interrupted');
        expect(chatSessionReducer(partial, { type: 'dropped', messageId: other })).toBe(partial);
        expect(chatSessionReducer(dropped, { type: 'dropped', messageId: reply })).toBe(dropped);
        expect(chatSessionReducer(dropped, { type: 'resume' })).toMatchObject({
            phase: 'streaming',
            reply: { lastSeq: 1 },
        });
        expect(chatSessionReducer(partial, { type: 'resume' })).toBe(partial);
        const settled = chatSessionReducer(dropped, { type: 'settled' });
        expect(settled).toMatchObject({ phase: 'done', reply: null });
        expect(settled.partials.get(reply)).toBe('Part');
        expect(chatSessionReducer(partial, { type: 'settled' })).toBe(partial);
    });

    it('ends a cancelled stream as done and a failed one as an error that keeps the reply', () => {
        const partial = run(...streaming(), { type: 'delta', messageId: reply, seq: 1, text: 'Part' });
        expect(chatSessionReducer(partial, { type: 'failed', messageId: reply, cancelled: true })).toMatchObject({
            phase: 'done',
            reply: null,
        });
        const failed = chatSessionReducer(partial, { type: 'failed', messageId: reply, cancelled: false });
        expect(failed).toMatchObject({ phase: 'error', reply: { messageId: reply } });
        expect(chatSessionReducer(partial, { type: 'failed', messageId: other, cancelled: false })).toBe(partial);
        expect(chatSessionReducer(failed, { type: 'send', content: 'Again' })).toMatchObject({
            phase: 'sending',
            reply: null,
        });
    });

    it('follows a reply it did not send', () => {
        expect(run({ type: 'follow', messageId: other })).toMatchObject({
            phase: 'streaming',
            reply: { messageId: other, text: '', lastSeq: 0 },
        });
    });

    it('counts sending, streaming and stopping as active', () => {
        expect(['sending', 'streaming', 'stopping'].every((phase) => isReplyActive(phase as never))).toBe(true);
        expect(['idle', 'done', 'interrupted', 'error'].some((phase) => isReplyActive(phase as never))).toBe(false);
    });
});
