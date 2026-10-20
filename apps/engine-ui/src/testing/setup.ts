import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// jsdom has no layout, so it does not implement scrolling; the router restores scroll position after navigation.
window.scrollTo = () => undefined;

beforeEach(() => {
    window.__ptbkCspViolations = [];
});

afterEach(() => {
    cleanup();
});
