import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderApp } from '../../testing/render-app';

// Paraglide resolves the first locale once per page load, so the Czech page lives in its own test file.
describe('trust page for a Czech browser', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders in Czech, with the Czech footer and language label', async () => {
        const app = renderApp({ path: '/trust' });
        expect(await screen.findByRole('heading', { name: 'Jak vás Promptbook chrání', level: 1 })).toBeTruthy();
        expect(screen.getByText(/Obsah enginu neukládá nikdy, ani zašifrovaný\./)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'CS, Jazyk: Čeština' })).toBeTruthy();
        expect(screen.getByRole('navigation', { name: 'O Promptbooku' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });
});
