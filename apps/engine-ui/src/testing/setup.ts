import { installDomGaps } from '@ptbk/ui';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// jsdom lacks <dialog>'s modal methods, the Popover API, matchMedia and scrolling (the router restores scroll).
installDomGaps();
// CodeMirror measures text ranges and calls editing commands; jsdom has neither layout nor an editing model.
Object.defineProperty(Document.prototype, 'execCommand', { value: () => false, configurable: true });
Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
Range.prototype.getBoundingClientRect = () => new DOMRect();

beforeEach(() => {
    window.__ptbkCspViolations = [];
});

afterEach(() => {
    cleanup();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('lang');
});
