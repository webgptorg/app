import { afterEach, describe, expect, it } from 'vitest';

import { mountInShadow } from './shadow-mount';

describe('mountInShadow', () => {
    afterEach(() => {
        Reflect.deleteProperty(ShadowRoot.prototype, 'adoptedStyleSheets');
    });

    it('puts a fresh container into the host’s shadow root, reusing the root on a second mount', () => {
        const host = document.createElement('div');
        const first = mountInShadow(host);
        const second = mountInShadow(host);

        expect(host.shadowRoot?.children).toHaveLength(1);
        expect(host.shadowRoot?.firstElementChild).toBe(second);
        expect(first.isConnected).toBe(false);
        expect(second.className).toBe('book-editor-root');
        expect(host.children).toHaveLength(0);
    });

    it('adopts nothing in a document without a window, such as one made by DOMParser', () => {
        const detached = document.implementation.createHTMLDocument();
        const host = detached.createElement('div');

        expect(mountInShadow(host).ownerDocument).toBe(detached);
        expect('adoptedStyleSheets' in (host.shadowRoot as ShadowRoot)).toBe(false);
    });

    it('adopts the editor stylesheet once per root where constructable stylesheets exist', () => {
        const adopted = new WeakMap<ShadowRoot, CSSStyleSheet[]>();
        Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
            configurable: true,
            get(this: ShadowRoot) {
                return adopted.get(this) ?? [];
            },
            set(this: ShadowRoot, sheets: CSSStyleSheet[]) {
                adopted.set(this, sheets);
            },
        });
        const host = document.createElement('div');
        const other = document.createElement('div');

        mountInShadow(host);
        mountInShadow(host);
        mountInShadow(other);

        expect(host.shadowRoot?.adoptedStyleSheets).toHaveLength(1);
        expect(other.shadowRoot?.adoptedStyleSheets[0]).toBe(host.shadowRoot?.adoptedStyleSheets[0]);
        expect(host.shadowRoot?.adoptedStyleSheets[0]).toBeInstanceOf(CSSStyleSheet);
    });
});
