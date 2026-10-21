import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { billingView, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok } from '../../testing/scripted-api';

// Paraglide resolves the first locale once per page load, so the Czech scenario lives in its own test file.
describe('billing for a Czech browser', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the billing page in Czech', async () => {
        renderApp({
            path: '/billing',
            session: session({ permissions: ['org.read', 'billing.read', 'billing.manage'] }),
            script: (api) => api.on(apiRoutes.getBilling, ok(billingView())),
        });
        expect(await screen.findByRole('heading', { name: 'Fakturace', level: 1 })).toBeTruthy();
        expect(await screen.findByText('Bez předplatného')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Předplatit tarif standard' })).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Fakturace' })).toBeTruthy();
    });
});
