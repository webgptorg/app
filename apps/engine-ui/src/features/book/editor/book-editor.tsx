import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import type { Diagnostic as LintDiagnostic } from '@codemirror/lint';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import type { Diagnostic } from '@ptbk/engine-api';
import { useEffect, useImperativeHandle, useRef } from 'react';
import type { Ref } from 'react';

import { bookLanguage } from '../language/book-language';
import { diagnosticRange } from './diagnostic-range';
import { mountInShadow } from './shadow-mount';

export interface BookEditorHandle {
    /** Selects a diagnostic's range, scrolls to it and focuses the editor. */
    readonly focusRange: (range: Diagnostic['range']) => void;
    /** Replaces the whole text (a reload or a restore), without an undo step back to the old one. */
    readonly reset: (source: string) => void;
}

export interface BookEditorProps {
    /** The text when the editor mounts; later changes come from typing or `reset`. */
    readonly initialSource: string;
    readonly onChange: (source: string) => void;
    readonly diagnostics: readonly Diagnostic[];
    /** The editor's accessible name. */
    readonly label: string;
    readonly readOnly?: boolean;
    /** `Mod-s`; the browser's own "save page" is suppressed while the editor has focus. */
    readonly onSave?: () => void;
    readonly ref?: Ref<BookEditorHandle>;
}

function lintDiagnostics(state: EditorState, diagnostics: readonly Diagnostic[]): LintDiagnostic[] {
    return diagnostics.map((diagnostic) => ({
        ...diagnosticRange(state.doc, diagnostic.range),
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: diagnostic.code,
    }));
}

/**
 * The book editor: one CodeMirror view in a shadow root, with the book language, line numbers, undo history, search,
 * bracket matching and the engine's diagnostics as lint markers. Tab is left to focus navigation, so the editor never
 * traps the keyboard.
 */
export function BookEditor({
    initialSource,
    onChange,
    diagnostics,
    label,
    readOnly = false,
    onSave,
    ref,
}: BookEditorProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const extensionsRef = useRef<readonly Extension[]>([]);
    const readOnlyCompartment = useRef(new Compartment());
    const callbacks = useRef({ onChange, onSave });
    useEffect(() => {
        callbacks.current = { onChange, onSave };
    });
    const initial = useRef({ initialSource, readOnly, label, diagnostics });

    useEffect(() => {
        const host = hostRef.current;
        if (host === null) return;
        const { initialSource: doc, readOnly: startReadOnly, label: ariaLabel } = initial.current;
        const extensions: Extension[] = [
            lineNumbers(),
            highlightSpecialChars(),
            history(),
            search({ top: true }),
            bracketMatching(),
            lintGutter(),
            syntaxHighlighting(classHighlighter),
            bookLanguage(),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
            readOnlyCompartment.current.of(EditorState.readOnly.of(startReadOnly)),
            keymap.of([
                {
                    key: 'Mod-s',
                    preventDefault: true,
                    run: () => {
                        callbacks.current.onSave?.();
                        return true;
                    },
                },
                ...defaultKeymap,
                ...historyKeymap,
                ...searchKeymap,
                ...lintKeymap,
            ]),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
            }),
        ];
        const view = new EditorView({ parent: mountInShadow(host), state: EditorState.create({ doc, extensions }) });
        extensionsRef.current = extensions;
        view.dispatch(setDiagnostics(view.state, lintDiagnostics(view.state, initial.current.diagnostics)));
        viewRef.current = view;
        return () => {
            view.destroy();
            viewRef.current = null;
        };
    }, []);

    useEffect(() => {
        const view = viewRef.current;
        if (view === null) return;
        view.dispatch(setDiagnostics(view.state, lintDiagnostics(view.state, diagnostics)));
    }, [diagnostics]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
        });
    }, [readOnly]);

    useImperativeHandle(
        ref,
        () => ({
            focusRange: (range) => {
                const view = viewRef.current;
                if (view === null) return;
                const { from, to } = diagnosticRange(view.state.doc, range);
                view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true });
                view.focus();
            },
            reset: (source) => {
                const view = viewRef.current;
                if (view === null) return;
                // A fresh state, so undo cannot replay edits made to the replaced text.
                view.setState(EditorState.create({ doc: source, extensions: [...extensionsRef.current] }));
            },
        }),
        [],
    );

    return <div ref={hostRef} className="min-h-96 min-w-0" data-testid="book-editor" />;
}
