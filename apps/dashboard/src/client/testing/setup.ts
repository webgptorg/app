import { installDomGaps } from '@ptbk/ui';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom lacks <dialog>'s modal methods, the Popover API, matchMedia and scrolling (the router restores scroll).
installDomGaps();

afterEach(() => {
    cleanup();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    document.cookie = 'ptbk_locale=; Max-Age=0; Path=/';
});
