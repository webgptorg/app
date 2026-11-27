import { installDomGaps } from '@ptbk/ui';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// jsdom lacks <dialog>'s modal methods, the Popover API, matchMedia and scrolling (the router restores scroll).
installDomGaps();

// The first test in a file pays for transforming its lazy route chunks, which takes over findBy's default 1 s on a
// busy CI runner. A passing wait returns as soon as the element appears, so the larger budget only slows real
// failures, and the same value locally means a local run is never stricter than CI.
configure({ asyncUtilTimeout: 5_000 });

beforeEach(() => {
    window.__ptbkCspViolations = [];
});

afterEach(() => {
    cleanup();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('lang');
});
