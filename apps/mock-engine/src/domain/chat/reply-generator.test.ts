import { describe, expect, it } from 'vitest';

import {
    HOSTILE_IMAGE,
    HOSTILE_LINK,
    HOSTILE_LONG_LINE_LENGTH,
    HOSTILE_RAW_IMAGE,
    HOSTILE_SCRIPT,
    generateReply,
    tokenize,
} from './reply-generator';
import type { ReplyInput } from './reply-generator';

const input = (overrides: Partial<ReplyInput> = {}): ReplyInput => ({
    seed: 42,
    chatId: 'chat-1',
    messageIndex: 0,
    agentName: 'Ada',
    content: 'How should we roll out the new release?',
    hostile: false,
    ...overrides,
});

const text = (reply: ReturnType<typeof generateReply>): string => reply.chunks.map((chunk) => chunk.text).join('');

describe('generateReply', () => {
    it('is identical for the same seed, chat and message index', () => {
        expect(generateReply(input())).toEqual(generateReply(input()));
    });

    it('differs for another message index, chat or seed', () => {
        const base = text(generateReply(input()));
        const others = [
            ...Array.from({ length: 5 }, (_, index) => input({ messageIndex: index + 1 })),
            input({ chatId: 'chat-2' }),
            input({ seed: 7 }),
        ].map((other) => generateReply(other));
        expect(others.some((other) => text(other) !== base)).toBe(true);
        expect(generateReply(input({ messageIndex: 1 }))).not.toEqual(generateReply(input()));
    });

    it('always contains a fenced code block and stays a modest length', () => {
        for (let messageIndex = 0; messageIndex < 50; messageIndex++) {
            const reply = generateReply(input({ messageIndex, seed: messageIndex * 31 }));
            expect(text(reply)).toMatch(/```(?:ts|bash|json)\n[\s\S]+?\n```/);
            expect(reply.chunks.length).toBeGreaterThanOrEqual(60);
            expect(reply.chunks.length).toBeLessThanOrEqual(250);
        }
    });

    it('produces paragraphs, lists, links and sometimes a table', () => {
        const replies = Array.from({ length: 20 }, (_, messageIndex) => text(generateReply(input({ messageIndex }))));
        for (const reply of replies) {
            expect(reply).toContain('\n\n');
            expect(reply).toMatch(/^(?:- |\d+\. )/m);
            expect(reply).toMatch(/\]\(https:\/\/example\.com\//);
        }
        expect(replies.some((reply) => reply.includes('| --- |'))).toBe(true);
    });

    it('paces tokens around the requested rate with jitter', () => {
        const reply = generateReply(input());
        for (const chunk of reply.chunks) {
            expect(Number.isInteger(chunk.delayMs)).toBe(true);
            expect(chunk.delayMs).toBeGreaterThanOrEqual(Math.floor((1000 / 30) * 0.6));
            expect(chunk.delayMs).toBeLessThanOrEqual(Math.ceil((1000 / 30) * 1.4));
        }
        expect(new Set(reply.chunks.map((chunk) => chunk.delayMs)).size).toBeGreaterThan(1);
        const fast = generateReply(input({ tokensPerSecond: 1000 }));
        expect(fast.chunks.every((chunk) => chunk.delayMs <= 2)).toBe(true);
    });

    it('echoes a truncated quote of the question and handles an empty one', () => {
        expect(text(generateReply(input({ content: 'x'.repeat(500) })))).toContain(`"${'x'.repeat(60)}…"`);
        expect(text(generateReply(input({ content: '   ' })))).not.toContain('You asked');
    });

    it('adds every hostile marker only in hostile mode', () => {
        const hostile = text(generateReply(input({ hostile: true })));
        for (const marker of [HOSTILE_IMAGE, HOSTILE_SCRIPT, HOSTILE_RAW_IMAGE, HOSTILE_LINK])
            expect(hostile).toContain(marker);
        expect(Math.max(...hostile.split('\n').map((line) => line.length))).toBeGreaterThanOrEqual(
            HOSTILE_LONG_LINE_LENGTH,
        );
        const benign = text(generateReply(input()));
        for (const marker of ['attacker.example', '<script', 'javascript:']) expect(benign).not.toContain(marker);
    });
});

describe('tokenize', () => {
    it('splits into word and punctuation tokens that concatenate back', () => {
        const sample = '  Hello, world!\n\n- item  \n';
        const tokens = tokenize(sample);
        expect(tokens.join('')).toBe(sample);
        expect(tokens).toEqual(['  Hello', ',', ' world', '!', '\n\n-', ' item', '  \n']);
        expect(tokenize('')).toEqual([]);
    });
});
