import { describe, expect, it, vi } from 'vitest';

import { highlightLines, loadHighlighter, MAX_HIGHLIGHT_LENGTH } from './highlight';
import { pushToken } from './tokens';
import type { HighlightedLine, HighlightToken } from './tokens';
import { streamHighlighter } from './languages/stream';

const textOf = (lines: readonly HighlightedLine[]) =>
    lines.map((line) => line.map((token) => token.text).join('')).join('\n');
const classesOf = (lines: readonly HighlightedLine[]) =>
    new Set(lines.flatMap((line) => line.flatMap((token) => token.className.split(' ').filter(Boolean))));

describe('loadHighlighter', () => {
    it.each([
        ['js', 'const answer = 42; // done', 'tok-keyword'],
        ['JavaScript', 'let s = "x";', 'tok-string'],
        ['mjs', 'export default 1;', 'tok-keyword'],
        ['cjs', 'module.exports = {};', 'tok-variableName'],
        ['jsx', 'const a = <div className="x">hi</div>;', 'tok-typeName'],
        ['ts', 'const status: string = await check();', 'tok-typeName'],
        ['typescript', 'interface A { readonly b: number }', 'tok-keyword'],
        ['mts', 'type T = string;', 'tok-keyword'],
        ['cts', 'enum E { A }', 'tok-keyword'],
        ['tsx', 'const c = <Box<string> value={1} />;', 'tok-keyword'],
        ['json', '{ "ok": true, "n": 1 }', 'tok-bool'],
        ['py', 'def f():\n    return "hi"', 'tok-keyword'],
        ['python', '# note\nx = 1', 'tok-comment'],
        ['sh', 'echo "hi" # greet', 'tok-string'],
        ['bash', 'if [ -f x ]; then\n  ls\nfi', 'tok-keyword'],
        ['shell', 'export NAME=value', 'tok-keyword'],
        ['zsh', 'echo $HOME', 'tok-variableName2'],
        ['css', 'a { color: red; }', 'tok-propertyName'],
        ['html', '<p class="x">hi</p>', 'tok-typeName'],
        ['htm', '<!-- c -->', 'tok-comment'],
        ['sql', 'SELECT 1 FROM t -- c', 'tok-keyword'],
        ['yaml', 'name: demo\ncount: 3', 'tok-propertyName'],
        ['yml', '# c\na: b', 'tok-comment'],
        ['md', '# Title', 'tok-heading'],
        ['markdown', '*em*', 'tok-emphasis'],
    ])('highlights %s and keeps the text exactly', async (lang, code, expected) => {
        const highlighter = await loadHighlighter(lang);
        expect(highlighter).not.toBeNull();
        const lines = highlighter?.(code) ?? [];
        expect(textOf(lines)).toBe(code);
        expect(classesOf(lines)).toContain(expected);
    });

    it.each(['brainfuck', '', 'constructor', '__proto__', 'toString'])('has no highlighter for %j', async (lang) => {
        expect(await loadHighlighter(lang)).toBeNull();
    });
});

describe('highlightLines', () => {
    it('splits highlighted code into lines', async () => {
        const lines = await highlightLines('SELECT 1;\n\nSELECT 2;', 'sql');
        expect(lines).toHaveLength(3);
        expect(lines?.[1]).toEqual([]);
    });

    it('leaves code plain when it is too long or the language is unknown', async () => {
        expect(await highlightLines('x'.repeat(MAX_HIGHLIGHT_LENGTH + 1), 'ts')).toBeNull();
        expect(await highlightLines('x', 'cobol')).toBeNull();
    });
});

describe('streamHighlighter', () => {
    it('takes a character as plain text when a mode consumes nothing, instead of looping', () => {
        const token = vi.fn(() => null);
        expect(streamHighlighter({ token })('ab')).toEqual([[{ text: 'ab', className: '' }]]);
        expect(token).toHaveBeenCalledTimes(2);
    });

    it('starts from the mode state, tells it about blank lines, and maps style names', () => {
        const state = { lines: 0 };
        const blankLine = vi.fn();
        const highlight = streamHighlighter({
            startState: () => state,
            blankLine,
            token: (stream) => {
                const word = stream.match(/^\S+/);
                if (!word) {
                    stream.next();
                    return null;
                }
                return stream.current() === 'x' ? 'variableName.special' : 'mystery';
            },
        });
        expect(highlight('x y\n\nz')).toEqual([
            [
                { text: 'x', className: 'tok-variableName' },
                { text: ' y', className: '' },
            ],
            [],
            [{ text: 'z', className: '' }],
        ]);
        expect(blankLine).toHaveBeenCalledWith(state, 2);
    });
});

describe('pushToken', () => {
    it('skips empty text and merges runs with the same classes', () => {
        const line: HighlightToken[] = [];
        pushToken(line, '', 'tok-keyword');
        pushToken(line, 'a', 'tok-keyword');
        pushToken(line, 'b', 'tok-keyword');
        pushToken(line, 'c', '');
        expect(line).toEqual([
            { text: 'ab', className: 'tok-keyword' },
            { text: 'c', className: '' },
        ]);
    });
});
