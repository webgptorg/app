import { Change, diff } from '@codemirror/merge';

/** The private use area: one code unit per distinct line, so a line can never be split by the character diff. */
const FIRST_LINE_CODE = 0xe000;
const LINE_CODES = 0xf8ff - FIRST_LINE_CODE + 1;

interface Lines {
    /** Offset where each line starts, plus the text's length at the end. */
    readonly starts: readonly number[];
    readonly encoded: string;
}

function splitLines(text: string, codes: Map<string, string>): Lines | null {
    const starts: number[] = [];
    let encoded = '';
    let start = 0;
    for (const line of text.split('\n')) {
        let code = codes.get(line);
        if (code === undefined) {
            if (codes.size === LINE_CODES) return null;
            code = String.fromCharCode(FIRST_LINE_CODE + codes.size);
            codes.set(line, code);
        }
        starts.push(start);
        encoded += code;
        start += line.length + 1;
    }
    starts.push(text.length);
    return { starts, encoded };
}

/** End of line `index`, before its newline; -1 before the first line. */
function lineEnd(lines: Lines, index: number): number {
    if (index < 0) return 0;
    const next = lines.starts[index + 1] ?? 0;
    return index + 2 === lines.starts.length ? next : next - 1;
}

function lineStart(lines: Lines, index: number): number {
    return lines.starts[index] ?? 0;
}

/**
 * Whole-line changes from `a` to `b`, for `@codemirror/merge`'s `diffConfig.override`. Its default diff works on
 * characters, so a changed line could show up as an unchanged one removed and added again; a book is read line by
 * line. Null when the texts have more distinct lines than one diff can tell apart; use the default diff then.
 */
export function lineChanges(a: string, b: string): readonly Change[] | null {
    const codes = new Map<string, string>();
    const linesA = splitLines(a, codes);
    const linesB = splitLines(b, codes);
    if (linesA === null || linesB === null) return null;
    const lastA = linesA.starts.length - 2;
    const lastB = linesB.starts.length - 2;
    const changes: Change[] = [];
    for (const change of diff(linesA.encoded, linesB.encoded)) {
        const previous = changes.at(-1);
        // Line ranges [fromA, toA) and [fromB, toB) of the hunk; neighbours with no common line between them merge.
        if (previous !== undefined && previous.toA === change.fromA && previous.toB === change.fromB) {
            changes[changes.length - 1] = new Change(previous.fromA, change.toA, previous.fromB, change.toB);
        } else {
            changes.push(change);
        }
    }
    return changes.map(({ fromA, toA, fromB, toB }) => {
        // A hunk that reaches the end takes the newline before it instead of the one after: the last line has none.
        if (toA > lastA || toB > lastB) {
            return new Change(
                lineEnd(linesA, fromA - 1),
                lineEnd(linesA, toA - 1),
                lineEnd(linesB, fromB - 1),
                lineEnd(linesB, toB - 1),
            );
        }
        return new Change(
            lineStart(linesA, fromA),
            lineStart(linesA, toA),
            lineStart(linesB, fromB),
            lineStart(linesB, toB),
        );
    });
}

export interface LineCounts {
    readonly added: number;
    readonly removed: number;
}

/** How many lines `b` adds to `a` and removes from it, a changed line counting once each way. */
export function countLineChanges(a: string, b: string): LineCounts | null {
    const codes = new Map<string, string>();
    const linesA = splitLines(a, codes);
    const linesB = splitLines(b, codes);
    if (linesA === null || linesB === null) return null;
    let added = 0;
    let removed = 0;
    for (const { fromA, toA, fromB, toB } of diff(linesA.encoded, linesB.encoded)) {
        removed += toA - fromA;
        added += toB - fromB;
    }
    return { added, removed };
}
