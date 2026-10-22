import { StreamLanguage } from '@codemirror/language';
import type { StreamParser } from '@codemirror/language';

import { BUILT_IN_COMMITMENTS } from './commitments';

interface BookState {
    /** The first non-blank line names the agent; everything after it is commitments and their text. */
    named: boolean;
    /** At the start of a line, after any indentation: where a commitment keyword may stand. */
    lineStart: boolean;
    /** The rest of the line is a comment (`//` or a `NOTE`). */
    comment: boolean;
}

const COMMITMENT_SHAPE = /^[A-Z][A-Z0-9_]*(?: [A-Z][A-Z0-9_]*)*$/;
const URL = /^https?:\/\/[^\s<>"'`]+/;
const PARAMETER = /^\{[^{}\s]{1,64}\}/;
// Plain text up to the next character that could start a URL or a parameter.
const PLAIN = /^(?:[^{h]|h(?!ttps?:\/\/))+/;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One regular expression for every keyword, longest first so `INITIAL MESSAGE` wins over `INITIAL`; a keyword must
 * end at a word boundary. Keywords of any other shape are ignored, so a list from elsewhere cannot inject a pattern.
 */
export function commitmentPattern(keywords: readonly string[]): RegExp {
    const phrases = [...new Set(keywords.filter((keyword) => COMMITMENT_SHAPE.test(keyword)))]
        .filter((keyword) => keyword !== 'META')
        .toSorted((a, b) => b.length - a.length)
        .map(escapeRegExp);
    return new RegExp(`^(?:META(?: [A-Z][A-Z0-9_]*)?|${[...phrases, '(?!)'].join('|')})(?![A-Za-z0-9_])`);
}

/** The book tokenizer: agent name, commitment keywords, comments, URLs and `{parameters}`. */
export function bookStreamParser(keywords: readonly string[] = BUILT_IN_COMMITMENTS): StreamParser<BookState> {
    const commitment = commitmentPattern(keywords);
    return {
        name: 'book',
        startState: () => ({ named: false, lineStart: true, comment: false }),
        token(stream, state) {
            if (stream.sol()) {
                state.lineStart = true;
                state.comment = false;
            }
            if (!state.named) {
                if (stream.match(/^\s*$/)) return null;
                state.named = true;
                stream.skipToEnd();
                return 'heading';
            }
            if (state.comment) {
                stream.skipToEnd();
                return 'comment';
            }
            if (state.lineStart) {
                if (stream.eatSpace()) return null;
                state.lineStart = false;
                if (stream.match('//')) {
                    stream.skipToEnd();
                    return 'comment';
                }
                const keyword = stream.match(commitment);
                if (keyword !== null && keyword !== false && keyword !== true) {
                    if (keyword[0] === 'NOTE') state.comment = true;
                    return 'keyword';
                }
            }
            if (stream.match(URL)) return 'url';
            if (stream.match(PARAMETER)) return 'variableName';
            if (!stream.match(PLAIN)) stream.next();
            return null;
        },
        blankLine(state) {
            state.lineStart = true;
            state.comment = false;
        },
        copyState: (state) => ({ ...state }),
    };
}

/** The book language for CodeMirror; pass the engine's keywords when it lists them, else the built-in ones apply. */
export function bookLanguage(keywords?: readonly string[]): StreamLanguage<BookState> {
    return StreamLanguage.define(bookStreamParser(keywords));
}
