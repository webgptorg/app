import { syntaxHighlighting } from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

import { bookLanguage } from '../language/book-language';
import { mountInShadow } from './shadow-mount';

export interface BookViewerProps {
    readonly source: string;
    /** Shows `source` as changes to this text: removed lines inline, added ones marked. */
    readonly compareWith?: string;
    /** The viewer's accessible name. */
    readonly label: string;
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
                doc: source,
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
                              original: compareWith,
                              mergeControls: false,
                              syntaxHighlightDeletions: true,
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
