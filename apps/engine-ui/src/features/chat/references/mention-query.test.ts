import { describe, expect, it } from 'vitest';

import { applyMention, findMentionQuery, matchMentionCandidates } from './mention-query';

describe('findMentionQuery', () => {
    it('finds @ and +@ right before the caret', () => {
        expect(findMentionQuery('Ask @Cop', 8)).toEqual({ start: 4, end: 8, text: 'Cop', addressing: false });
        expect(findMentionQuery('+@', 2)).toEqual({ start: 0, end: 2, text: '', addressing: true });
        expect(findMentionQuery('hi (+@Lead b', 12)).toEqual({ start: 4, end: 12, text: 'Lead b', addressing: true });
    });

    it.each([
        ['an e-mail address', 'ada@exam', 8],
        ['a mention on an earlier line', '@Ada\nhello', 10],
        ['a query that starts with a space', '@ x', 3],
        ['no @ at all', 'hello', 5],
        ['a run longer than any name', `@${'x'.repeat(60)}`, 61],
    ])('ignores %s', (_case, text, caret) => {
        expect(findMentionQuery(text, caret)).toBeNull();
    });
});

describe('matchMentionCandidates', () => {
    const candidates = [
        { key: 'a', name: 'Copywriter' },
        { key: 'b', name: 'Lead copy bot' },
        { key: 'c', name: 'Chatter' },
        { key: 'd', name: 'Copy editor' },
    ];

    it('puts names that start with the query before names with a word that does, keeping order', () => {
        expect(matchMentionCandidates(candidates, 'cop', 10).map((candidate) => candidate.key)).toEqual([
            'a',
            'd',
            'b',
        ]);
        expect(matchMentionCandidates(candidates, '', 2).map((candidate) => candidate.key)).toEqual(['a', 'b']);
        expect(matchMentionCandidates(candidates, 'zz', 10)).toEqual([]);
    });
});

describe('applyMention', () => {
    it('replaces the query with the name and a space', () => {
        expect(
            applyMention('Ask @Cop now', { start: 4, end: 8, text: 'Cop', addressing: false }, 'Copywriter'),
        ).toEqual({ text: 'Ask @Copywriter now', caret: 16 });
        expect(applyMention('Ask @Cop', { start: 4, end: 8, text: 'Cop', addressing: false }, 'Copywriter')).toEqual({
            text: 'Ask @Copywriter ',
            caret: 16,
        });
    });

    it('removes an addressing query, which becomes the address chip instead', () => {
        expect(applyMention('+@Cop hello', { start: 0, end: 5, text: 'Cop', addressing: true }, 'Copywriter')).toEqual({
            text: 'hello',
            caret: 0,
        });
        expect(applyMention('so +@Cop', { start: 3, end: 8, text: 'Cop', addressing: true }, 'Copywriter')).toEqual({
            text: 'so ',
            caret: 3,
        });
    });
});
