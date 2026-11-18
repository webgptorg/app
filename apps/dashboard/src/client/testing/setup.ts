import { installDomGaps } from '@ptbk/ui';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom lacks <dialog>'s modal methods, the Popover API, matchMedia and scrolling (the router restores scroll).
installDomGaps();

// Same budget as engine-ui: lazy route chunks make the first wait in a file slow on a busy CI runner, and a passing
// wait returns as soon as the element appears.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
    cleanup();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    document.cookie = 'ptbk_locale=; Max-Age=0; Path=/';
});
