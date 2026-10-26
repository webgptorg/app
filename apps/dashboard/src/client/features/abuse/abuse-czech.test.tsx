import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { renderApp } from '../../testing/render-app';
import { ok } from '../../testing/scripted-api';

// Paraglide resolves the first locale once per page load, so the Czech page lives in its own test file.
describe('abuse page for a Czech browser', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders in Czech, signed out', async () => {
        const app = renderApp({
            path: '/abuse',
            script: (api) => api.on(apiRoutes.getAbuseContact, ok({ email: 'abuse@ptbk.test' })),
        });
        expect(await screen.findByRole('heading', { name: 'Nahlásit zneužití', level: 1 })).toBeTruthy();
        expect(document.documentElement.lang).toBe('cs');
        expect(screen.getByRole('heading', { name: 'Co vidíme a co ne' })).toBeTruthy();
        expect((await screen.findByRole('link', { name: 'abuse@ptbk.test' })).getAttribute('href')).toBe(
            'mailto:abuse@ptbk.test',
        );
        await expectNoAxeViolations(app.container);
    });
});
