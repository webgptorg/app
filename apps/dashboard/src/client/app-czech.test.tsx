import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { session } from './testing/fixtures';
import { renderApp } from './testing/render-app';

// Paraglide resolves the first locale once per page load, so each locale scenario lives in its own test file.
describe('app for a Czech browser', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders in Czech when no cookie is set', async () => {
        expect(document.cookie).toBe('');
        renderApp({ path: '/', session: session() });
        expect(await screen.findByRole('heading', { name: 'Vaše enginy' })).toBeTruthy();
        expect(document.documentElement.lang).toBe('cs');
        expect(screen.getByRole('link', { name: 'Účet' })).toBeTruthy();
    });
});
