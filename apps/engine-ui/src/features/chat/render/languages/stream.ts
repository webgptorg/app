import { StringStream } from '@codemirror/language';
import type { StreamParser } from '@codemirror/language';

import { pushToken } from '../tokens';
import type { HighlightToken, Highlighter } from '../tokens';

const TAB_SIZE = 4;
const INDENT_UNIT = 2;

/** CodeMirror 5 style names, as legacy modes return them, mapped onto the class names `classHighlighter` uses. */
const STYLE_CLASSES: ReadonlyMap<string, string> = new Map(
    Object.entries({
        keyword: 'tok-keyword',
        atom: 'tok-atom',
        bool: 'tok-bool',
        number: 'tok-number',
        string: 'tok-string',
        'string-2': 'tok-string2',
        comment: 'tok-comment',
        operator: 'tok-operator',
        meta: 'tok-meta',
        builtin: 'tok-variableName2',
        def: 'tok-variableName tok-definition',
        variable: 'tok-variableName',
        variableName: 'tok-variableName',
        'variable-2': 'tok-variableName2',
        type: 'tok-typeName',
        typeName: 'tok-typeName',
        attribute: 'tok-propertyName',
        property: 'tok-propertyName',
        propertyName: 'tok-propertyName',
        punctuation: 'tok-punctuation',
        bracket: 'tok-punctuation',
        tag: 'tok-typeName',
        link: 'tok-url',
        url: 'tok-url',
        header: 'tok-heading',
        heading: 'tok-heading',
        error: 'tok-invalid',
        invalid: 'tok-invalid',
    }),
);

/** `variableName.special` style names carry a base name and modifiers; only the base picks the class. */
function classesOf(style: string | null): string {
    return STYLE_CLASSES.get(style?.replace(/[.\s].*$/s, '') ?? '') ?? '';
}

/** A legacy CodeMirror stream mode (shell, SQL) run line by line, without an editor. */
export function streamHighlighter(mode: StreamParser<unknown>): Highlighter {
    return (code) => {
        const state: unknown = mode.startState?.(INDENT_UNIT) ?? true;
        return code.split('\n').map((text) => {
            const line: HighlightToken[] = [];
            if (text === '') {
                mode.blankLine?.(state, INDENT_UNIT);
                return line;
            }
            const stream = new StringStream(text, TAB_SIZE, INDENT_UNIT);
            while (!stream.eol()) {
                stream.start = stream.pos;
                const style = mode.token(stream, state);
                // A mode that consumes nothing would loop forever; take one character as plain text instead.
                if (stream.pos <= stream.start) stream.pos = stream.start + 1;
                pushToken(line, text.slice(stream.start, stream.pos), classesOf(style));
            }
            return line;
        });
    };
}
