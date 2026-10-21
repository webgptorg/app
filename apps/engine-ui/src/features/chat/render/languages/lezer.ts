import type { Parser } from '@lezer/common';
import { classHighlighter, highlightCode } from '@lezer/highlight';

import { pushToken } from '../tokens';
import type { HighlightToken, Highlighter } from '../tokens';

/** A Lezer grammar's highlighting, with the class names of `classHighlighter`. */
export function lezerHighlighter(parser: Parser): Highlighter {
    return (code) => {
        let line: HighlightToken[] = [];
        const lines = [line];
        highlightCode(
            code,
            parser.parse(code),
            classHighlighter,
            (text, classes) => {
                pushToken(line, text, classes);
            },
            () => {
                line = [];
                lines.push(line);
            },
        );
        return lines;
    };
}
