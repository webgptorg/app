import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';

import { bookLanguage, commitmentPattern } from './book-language';

/** Every highlighted piece of `source` with its class, in document order. */
function highlights(source: string, keywords?: readonly string[]): [string, string][] {
    const state = EditorState.create({ doc: source, extensions: bookLanguage(keywords) });
    const tree = ensureSyntaxTree(state, source.length, 5_000);
    if (tree === null) throw new Error('The book did not parse in time');
    const pieces: [string, string][] = [];
    highlightTree(tree, classHighlighter, (from, to, classes) => {
        pieces.push([source.slice(from, to), classes]);
    });
    return pieces;
}

describe('the book language', () => {
    it('highlights the agent name, commitments, URLs and parameters', () => {
        const source = [
            '',
            'Ada Lovelace',
            'PERSONA Reviews {project} pull requests',
            'KNOWLEDGE https://example.com/guide.pdf',
            '  RULE Never share secrets',
        ].join('\n');

        expect(highlights(source)).toEqual([
            ['Ada Lovelace', 'tok-heading'],
            ['PERSONA', 'tok-keyword'],
            ['{project}', 'tok-variableName'],
            ['KNOWLEDGE', 'tok-keyword'],
            ['https://example.com/guide.pdf', 'tok-url'],
            ['RULE', 'tok-keyword'],
        ]);
    });

    it('takes multi-word commitments and META keys whole, and only at the start of a line', () => {
        const source = 'Ada\nINITIAL MESSAGE Hello\nMETA COLOR #ff0000\nUSE SEARCH ENGINE\nSay PERSONA here';

        expect(highlights(source)).toEqual([
            ['Ada', 'tok-heading'],
            ['INITIAL MESSAGE', 'tok-keyword'],
            ['META COLOR', 'tok-keyword'],
            ['USE SEARCH ENGINE', 'tok-keyword'],
        ]);
    });

    it('highlights comments and NOTE text as comments, and leaves unknown upper-case words plain', () => {
        const source = 'Ada\n// a comment with https://example.com\nNOTE for humans {x}\nPERSONALITY Bold';

        expect(highlights(source)).toEqual([
            ['Ada', 'tok-heading'],
            ['// a comment with https://example.com', 'tok-comment'],
            ['NOTE', 'tok-keyword'],
            [' for humans {x}', 'tok-comment'],
        ]);
    });

    it('uses a keyword list it is given instead of the built-in one', () => {
        expect(highlights('Ada\nWALLET main\nPERSONA x', ['WALLET'])).toEqual([
            ['Ada', 'tok-heading'],
            ['WALLET', 'tok-keyword'],
        ]);
    });

    it('ignores keywords that are not upper-case words, so a list cannot inject a pattern', () => {
        const pattern = commitmentPattern(['RULE', '.*', 'a(b', 'Persona']);

        expect(pattern.test('RULE x')).toBe(true);
        expect(pattern.test('anything')).toBe(false);
        expect(pattern.test('Persona x')).toBe(false);
    });
});
