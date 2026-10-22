import type { Text } from '@codemirror/state';
import type { Diagnostic } from '@ptbk/engine-api';

export interface DocumentRange {
    readonly from: number;
    readonly to: number;
}

/**
 * Where an engine diagnostic (1-based lines and columns, end inclusive) lies in the document, clamped to it: a
 * diagnostic computed for an older text, or simply wrong, still lands on a real position instead of throwing.
 */
export function diagnosticRange(doc: Text, range: Diagnostic['range']): DocumentRange {
    const position = (lineNumber: number, column: number) => {
        const line = doc.line(Math.min(Math.max(lineNumber, 1), doc.lines));
        return line.from + Math.min(Math.max(column, 0), line.length);
    };
    const from = position(range.startLine, range.startColumn - 1);
    const to = position(range.endLine, range.endColumn);
    return to < from ? { from, to: from } : { from, to };
}
