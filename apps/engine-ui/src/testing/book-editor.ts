import { EditorView } from '@codemirror/view';
import { act, fireEvent, screen } from '@testing-library/react';

/**
 * CodeMirror measures text ranges and calls editing commands; jsdom has neither layout nor an editing model. Called by
 * the test files that mount an editor, so no other suite runs with these stand-ins.
 */
export function installEditorDomGaps(): void {
    Object.defineProperty(Document.prototype, 'execCommand', { value: () => false, configurable: true });
    Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
    Range.prototype.getBoundingClientRect = () => new DOMRect();
}

/** The CodeMirror view inside a book editor or viewer host (`data-testid`), which lives in a shadow root. */
export function editorView(testId: 'book-editor' | 'book-viewer' = 'book-editor', index = 0): EditorView {
    const host = screen.getAllByTestId(testId)[index];
    const element = host?.shadowRoot?.querySelector<HTMLElement>('.cm-editor');
    const view = element === null || element === undefined ? null : EditorView.findFromDOM(element);
    if (view === null) throw new Error(`No editor view in ${testId}`);
    return view;
}

export function bookText(testId: 'book-editor' | 'book-viewer' = 'book-editor', index = 0): string {
    return editorView(testId, index).state.doc.toString();
}

/** Types by transaction: jsdom has no editing model for CodeMirror's contenteditable to observe. */
export function replaceBook(text: string): void {
    const view = editorView();
    act(() => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
    });
}

export function appendToBook(text: string): void {
    const view = editorView();
    act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' });
    });
}

/** `Mod-s` as CodeMirror's keymap sees it (jsdom is not a Mac, so `Mod` is Control). */
export function pressSaveShortcut(): void {
    fireEvent.keyDown(editorView().contentDOM, { key: 's', code: 'KeyS', ctrlKey: true });
}
