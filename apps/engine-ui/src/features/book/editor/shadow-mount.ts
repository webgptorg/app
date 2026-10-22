import editorStyles from './book-editor.css?inline';

const sheets = new WeakMap<Document, CSSStyleSheet>();

function editorSheet(doc: Document): CSSStyleSheet | null {
    const view = doc.defaultView;
    if (view === null || typeof view.CSSStyleSheet.prototype.replaceSync !== 'function') return null;
    let sheet = sheets.get(doc);
    if (sheet === undefined) {
        sheet = new view.CSSStyleSheet();
        sheet.replaceSync(editorStyles);
        sheets.set(doc, sheet);
    }
    return sheet;
}

/**
 * A container for a CodeMirror view inside `host`'s shadow root, with the editor's stylesheet adopted there.
 *
 * CodeMirror injects its own styles through style-mod, which uses a constructable stylesheet only in a shadow root;
 * in the document it would add a `<style>` element, which the engine's `style-src 'self'` refuses (ADR 0013). Our
 * stylesheet is constructed and adopted the same way, so nothing in the editor depends on a `<style>` element.
 */
export function mountInShadow(host: HTMLElement): HTMLElement {
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const sheet = editorSheet(host.ownerDocument);
    if (sheet !== null && 'adoptedStyleSheets' in root && !root.adoptedStyleSheets.includes(sheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
    const container = host.ownerDocument.createElement('div');
    container.className = 'book-editor-root';
    root.replaceChildren(container);
    return container;
}
