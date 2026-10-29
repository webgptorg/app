import { syntaxHighlighting } from '@codemirror/language';
import { diff, unifiedMergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

import { bookLanguage } from '../language/book-language';
import { lineChanges } from '../line-diff';
import { mountInShadow } from './shadow-mount';

export interface BookViewerProps {
    readonly source: string;
    /** Shows `source` as changes to this text, whole lines at a time: removed lines inline, added ones marked. */
    readonly compareWith?: string;
    /** The viewer's accessible name. */
    readonly label: string;
}

/**
 * Ends the text with a newline. The merge view widens a change that starts at the very end of a text to the whole line
 * before it, so without one, removing the last lines would show the unchanged line above them as removed and re-added.
 */
function withFinalNewline(text: string): string {
    return text.endsWith('\n') ? text : `${text}\n`;
}

/** A read-only book, highlighted like the editor; with `compareWith`, a unified diff (`@codemirror/merge`). */
export function BookViewer({ source, compareWith, label }: BookViewerProps) {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (host === null) return;
        const view = new EditorView({
            parent: mountInShadow(host),
            state: EditorState.create({
                doc: compareWith === undefined ? source : withFinalNewline(source),
                extensions: [
                    lineNumbers(),
                    highlightSpecialChars(),
                    syntaxHighlighting(classHighlighter),
                    bookLanguage(),
                    EditorView.lineWrapping,
                    EditorState.readOnly.of(true),
                    EditorView.contentAttributes.of({ 'aria-label': label }),
                    compareWith === undefined
                        ? []
                        : unifiedMergeView({
                              original: withFinalNewline(compareWith),
                              mergeControls: false,
                              syntaxHighlightDeletions: true,
                              diffConfig: { override: (a, b) => lineChanges(a, b) ?? diff(a, b) },
                          }),
                ],
            }),
        });
        return () => {
            view.destroy();
        };
    }, [source, compareWith, label]);

    return <div ref={hostRef} className="min-h-96 min-w-0" data-testid="book-viewer" />;
}
