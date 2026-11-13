import { ChatId, MessageId } from '@ptbk/engine-api';
import type { ReadMessage } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { flattenedProgress, parseFlattenedSteps } from './progress-fallback';

const chatId = ChatId.parse('Thread');
const CHATTER = { kind: 'agent', key: 'builtin-chatter' } as const;

function message(content: string, fields: Partial<ReadMessage> = {}): ReadMessage {
    return {
        type: 'message',
        id: MessageId.parse(`${chatId}#1`),
        chatId,
        author: CHATTER,
        content,
        status: 'completed',
        createdBy: null,
        createdAt: '2026-11-13T12:16:00Z' as ReadMessage['createdAt'],
        choices: [],
        phase: null,
        steps: [],
        ...fields,
    };
}

const SAMPLE =
    '- thinking: \n- Glob {specs,tasks,agents}/**/*.md*\n- Read /var/lib/ptbk/projects/demo/specs/_initial.md';

describe('parseFlattenedSteps', () => {
    it('reads the demo engine’s flattened steps', () => {
        expect(parseFlattenedSteps(SAMPLE)).toEqual([
            { kind: 'reasoning', tool: null, text: '', level: 'info' },
            { kind: 'tool', tool: 'Glob', text: '{specs,tasks,agents}/**/*.md*', level: 'info' },
            { kind: 'tool', tool: 'Read', text: '/var/lib/ptbk/projects/demo/specs/_initial.md', level: 'info' },
        ]);
        expect(parseFlattenedSteps('- mcp__ptbk__create_task Napsat krátký text o jaru')).toEqual([
            { kind: 'tool', tool: 'mcp__ptbk__create_task', text: 'Napsat krátký text o jaru', level: 'info' },
        ]);
        expect(parseFlattenedSteps('- thinking: Who writes copy here?\n\n- Bash ls -la\n')).toEqual([
            { kind: 'reasoning', tool: null, text: 'Who writes copy here?', level: 'info' },
            { kind: 'tool', tool: 'Bash', text: 'ls -la', level: 'info' },
        ]);
    });

    it('leaves ordinary lists and prose alone', () => {
        for (const text of [
            '- Apples are red\n- Bananas are yellow',
            '- Read the brief\n- Write the draft',
            '- Read the brief',
            '- WebSearch for prices',
            SAMPLE + '\nThat is all I found.',
            '- thinking: fine\n* Read /etc/hosts',
            '- **Read** /etc/hosts\n- thinking: x',
            '- mcp__ptbk__ create_task',
            '- mcp__ptbk__create_task\n- Here is the summary',
            '',
            '   \n',
            'Thinking about it: - thinking: no',
        ]) {
            expect(parseFlattenedSteps(text), text).toBeNull();
        }
    });

    it('caps step text at the contract’s length', () => {
        const steps = parseFlattenedSteps(`- thinking: ${'x'.repeat(900)}\n- Read /${'y'.repeat(900)}`);
        expect(steps?.map((step) => step.text.length)).toEqual([500, 500]);
    });

    it('keeps hostile text as text, never as markup', () => {
        const steps = parseFlattenedSteps('- Read /tmp/<img src=x onerror=alert(1)>\n- thinking: [link](javascript:x)');
        expect(steps?.map((step) => step.text)).toEqual(['/tmp/<img src=x onerror=alert(1)>', '[link](javascript:x)']);
    });
});

describe('flattenedProgress', () => {
    it('is progress only when the same agent goes on with the next message', () => {
        const next = message('Here is the plan.');
        expect(flattenedProgress(message(SAMPLE), next)).toHaveLength(3);
        expect(flattenedProgress(message(SAMPLE), undefined)).toBeNull();
        expect(flattenedProgress(message(SAMPLE), message('x', { author: { kind: 'agent', key: 'agent-copy' } }))).toBe(
            null,
        );
        expect(flattenedProgress(message(SAMPLE), message('x', { author: { kind: 'user', key: 'user' } }))).toBeNull();
    });

    it('trusts a phase the engine sends, and skips unfinished messages and the User', () => {
        const next = message('Done.');
        expect(flattenedProgress(message(SAMPLE, { phase: 'final' }), next)).toBeNull();
        expect(flattenedProgress(message(SAMPLE, { phase: 'progress' }), next)).toBeNull();
        expect(flattenedProgress(message(SAMPLE, { status: 'streaming' }), next)).toBeNull();
        const user = { kind: 'user', key: 'user' } as const;
        expect(flattenedProgress(message(SAMPLE, { author: user }), message('x', { author: user }))).toBeNull();
    });

    it('never eats a list reply, even one the same agent follows up', () => {
        const list = message('- Apples are red\n- Bananas are yellow\n- Read the label');
        expect(flattenedProgress(list, message('Anything else?'))).toBeNull();
    });
});
