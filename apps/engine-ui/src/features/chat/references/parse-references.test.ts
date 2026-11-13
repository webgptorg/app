import { describe, expect, it } from 'vitest';

import { createReferenceIndex, parseReferences } from './parse-references';

const index = createReferenceIndex(
    [
        { key: 'agent-copy', name: 'Copywriter' },
        { key: 'agent-chatter', name: 'Chatter' },
        { key: 'agent-lead', name: 'Lead bot' },
        { key: 'agent-lead-2', name: 'Lead' },
        { key: 'agent-dup', name: 'copywriter' },
    ],
    ['Napsat text na web', 'Fix {braces}'],
);

describe('parseReferences', () => {
    it('finds agents, addressing, the User and tasks among text', () => {
        expect(parseReferences('+@Copywriter, rewrite {Napsat text na web} for @Chatter. +@User ok?', index)).toEqual([
            { kind: 'agent', key: 'agent-copy', name: 'Copywriter', addressed: true },
            { kind: 'text', text: ', rewrite ' },
            { kind: 'task', name: 'Napsat text na web' },
            { kind: 'text', text: ' for ' },
            { kind: 'agent', key: 'agent-chatter', name: 'Chatter', addressed: false },
            { kind: 'text', text: '. ' },
            { kind: 'asks-user' },
            { kind: 'text', text: ' ok?' },
        ]);
    });

    it('matches names case-insensitively, the longest first, and keeps the first agent of a name', () => {
        expect(parseReferences('@lead bot and @Lead', index)).toEqual([
            { kind: 'agent', key: 'agent-lead', name: 'Lead bot', addressed: false },
            { kind: 'text', text: ' and ' },
            { kind: 'agent', key: 'agent-lead-2', name: 'Lead', addressed: false },
        ]);
        expect(parseReferences('@COPYWRITER', index)).toEqual([
            { kind: 'agent', key: 'agent-copy', name: 'Copywriter', addressed: false },
        ]);
    });

    it.each([
        ['an unknown agent', '@Nobody here'],
        ['an e-mail address', 'mail copywriter@Copywriter.cz'],
        ['a longer word', '@Copywriters and @Chattering'],
        ['a lone @', 'a @ b'],
        ['an unknown task', '{Something else}'],
        ['a { without its }', 'if (x) { return @'],
        ['a task split over lines', '{Napsat text\nna web}'],
        ['@User without the +', '@User'],
        ['an empty text', ''],
    ])('leaves %s as text', (_case, text) => {
        const segments = parseReferences(text, index);
        expect(segments.every((segment) => segment.kind === 'text')).toBe(true);
        expect(segments.map((segment) => (segment.kind === 'text' ? segment.text : '')).join('')).toBe(text);
    });

    it('accepts a task name with padding; a name with braces of its own cannot be referenced', () => {
        expect(parseReferences('{ Napsat text na web }!', index)).toEqual([
            { kind: 'task', name: 'Napsat text na web' },
            { kind: 'text', text: '!' },
        ]);
        expect(parseReferences('{Fix {braces}}', index)).toEqual([{ kind: 'text', text: '{Fix {braces}}' }]);
    });

    it('takes punctuation and other scripts as word boundaries', () => {
        expect(parseReferences('(@Chatter)', index).map((segment) => segment.kind)).toEqual(['text', 'agent', 'text']);
        expect(parseReferences('שלום @Chatter!', index).map((segment) => segment.kind)).toEqual([
            'text',
            'agent',
            'text',
        ]);
        expect(parseReferences('ž@Chatter', index).map((segment) => segment.kind)).toEqual(['text']);
    });

    it('stays linear on hostile input', () => {
        const text = `${'{'.repeat(20_000)}${'@'.repeat(20_000)}`;
        const started = performance.now();
        expect(parseReferences(text, index)).toEqual([{ kind: 'text', text }]);
        expect(performance.now() - started).toBeLessThan(2000);
    });

    it('treats an index with no tasks as having none, even for {}', () => {
        const empty = createReferenceIndex([], []);
        expect(parseReferences('{} @x +@User', empty)).toEqual([
            { kind: 'text', text: '{} @x ' },
            { kind: 'asks-user' },
        ]);
    });
});
