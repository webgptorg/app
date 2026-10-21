/** One run of code text and the `tok-*` classes it gets (empty for plain text). */
export interface HighlightToken {
    readonly text: string;
    readonly className: string;
}

export type HighlightedLine = readonly HighlightToken[];

/** Splits code into lines of tokens: data for React to render as spans, never markup. */
export type Highlighter = (code: string) => readonly HighlightedLine[];

/** Appends a run, merging it into the previous one when the classes match, so plain stretches stay one text node. */
export function pushToken(line: HighlightToken[], text: string, className: string): void {
    if (text === '') return;
    const last = line.at(-1);
    if (last?.className === className) line[line.length - 1] = { text: last.text + text, className };
    else line.push({ text, className });
}
