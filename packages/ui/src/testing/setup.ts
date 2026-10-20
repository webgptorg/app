import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { installDomGaps, resetMedia } from './dom-gaps';

installDomGaps();

afterEach(() => {
    cleanup();
    resetMedia();
    document.documentElement.className = '';
});
