import { installDomGaps } from '@ptbk/ui';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// jsdom lacks <dialog>'s modal methods, the Popover API, matchMedia and scrolling (the router restores scroll).
installDomGaps();

beforeEach(() => {
    window.__ptbkCspViolations = [];
});

afterEach(() => {
    cleanup();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('lang');
});
