import { MAX_BOOK_SOURCE_LENGTH, MAX_TEST_CHAT_MESSAGES, MAX_TEST_CHAT_TRANSCRIPT_LENGTH } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { checkTestRequest, INITIAL_TEST_CHAT, testChatReducer, transcriptOf } from './test-chat-session';
import type { TestChatAction, TestChatState } from './test-chat-session';

const run = (...actions: TestChatAction[]): TestChatState => actions.reduce(testChatReducer, INITIAL_TEST_CHAT);

describe('testChatReducer', () => {
    it('streams a reply into the conversation and counts it once completed', () => {
        const streaming = run(
            { type: 'send', content: 'hi' },
            { type: 'delta', text: 'Hel' },
            { type: 'delta', text: 'lo' },
        );
        expect(streaming).toMatchObject({ phase: 'streaming', reply: { text: 'Hello' } });
        const done = testChatReducer(streaming, { type: 'completed', content: 'Hello' });
        expect(done).toMatchObject({ phase: 'idle', reply: null, completedCount: 1 });
        expect(transcriptOf(done.turns)).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'agent', content: 'Hello' },
        ]);
    });

    it('ignores a send while a reply streams, and events once the reply ended', () => {
        const streaming = run({ type: 'send', content: 'hi' });
        expect(testChatReducer(streaming, { type: 'send', content: 'again' })).toBe(streaming);
        const stopped = testChatReducer(streaming, { type: 'stopped' });
        expect(testChatReducer(stopped, { type: 'delta', text: 'late' })).toBe(stopped);
        expect(testChatReducer(stopped, { type: 'completed', content: 'late' })).toBe(stopped);
        expect(testChatReducer(stopped, { type: 'failed', error: 'dropped' })).toBe(stopped);
        expect(testChatReducer(stopped, { type: 'stopped' })).toBe(stopped);
        expect(testChatReducer(stopped, { type: 'retry' })).toBe(stopped);
    });

    it('keeps a stopped reply in view but sends only one that said something', () => {
        const empty = run({ type: 'send', content: 'hi' }, { type: 'stopped' });
        expect(empty.turns.map(({ role, state }) => [role, state])).toEqual([
            ['user', null],
            ['agent', 'stopped'],
        ]);
        expect(transcriptOf(empty.turns)).toEqual([{ role: 'user', content: 'hi' }]);
        const partial = run({ type: 'send', content: 'hi' }, { type: 'delta', text: 'Half' }, { type: 'stopped' });
        expect(transcriptOf(partial.turns)).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'agent', content: 'Half' },
        ]);
    });

    it('replaces a failed partial reply when retried', () => {
        const failed = run(
            { type: 'send', content: 'hi' },
            { type: 'delta', text: 'Ha' },
            { type: 'failed', error: 'reply-failed' },
        );
        expect(failed).toMatchObject({ phase: 'error', error: 'reply-failed' });
        expect(transcriptOf(failed.turns)).toEqual([{ role: 'user', content: 'hi' }]);
        const retried = testChatReducer(failed, { type: 'retry' });
        expect(retried).toMatchObject({ phase: 'streaming', error: null, reply: { text: '' } });
        expect(retried.turns.map(({ role }) => role)).toEqual(['user']);
    });

    it('keeps the message after a refusal, so a retry sends it again', () => {
        const refused = run({ type: 'send', content: 'hi' }, { type: 'refused', error: 'invalid-book' });
        expect(refused).toMatchObject({ phase: 'error', error: 'invalid-book', reply: null });
        expect(testChatReducer(refused, { type: 'retry' }).turns).toHaveLength(1);
    });

    it('shows a blocked send without touching the conversation, and not over a streaming reply', () => {
        const idle = run({ type: 'blocked', error: 'too-large' });
        expect(idle).toMatchObject({ phase: 'idle', error: 'too-large', turns: [] });
        const streaming = run({ type: 'send', content: 'hi' });
        expect(testChatReducer(streaming, { type: 'blocked', error: 'limit' })).toBe(streaming);
    });

    it('forgets everything on reset but never reuses a turn ID', () => {
        const before = run({ type: 'send', content: 'hi' }, { type: 'completed', content: 'yo' });
        const reset = testChatReducer(before, { type: 'reset' });
        expect(reset).toMatchObject({ phase: 'idle', turns: [], reply: null, error: null, completedCount: 0 });
        const next = testChatReducer(reset, { type: 'send', content: 'again' });
        expect(before.turns.map(({ id }) => id)).not.toContain(next.turns[0]?.id);
    });
});

describe('checkTestRequest', () => {
    const turn = (content: string) => ({ role: 'user' as const, content });

    it('accepts a request within the limits', () => {
        expect(checkTestRequest('Ada', [turn('hi')])).toBeNull();
    });

    it('refuses an oversized book, too many turns and too much text', () => {
        expect(checkTestRequest('a'.repeat(MAX_BOOK_SOURCE_LENGTH + 1), [turn('hi')])).toBe('too-large');
        const many = Array.from({ length: MAX_TEST_CHAT_MESSAGES + 1 }, () => turn('hi'));
        expect(checkTestRequest('Ada', many)).toBe('limit');
        const long = Array.from({ length: 5 }, () => turn('x'.repeat(MAX_TEST_CHAT_TRANSCRIPT_LENGTH / 4)));
        expect(checkTestRequest('Ada', long)).toBe('limit');
    });
});
