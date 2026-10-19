import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRoutes } from '../shared/api/routes';
import { createFakeApiClient } from './api/fake-api-client';
import { App } from './app';

// Paraglide resolves the first locale once per page load, so each locale scenario lives in its own test file.
describe('app shell for a Czech browser', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the home page in Czech when no cookie is set', async () => {
        expect(document.cookie).toBe('');
        const apiClient = createFakeApiClient(
            new Map([[apiRoutes.getEnvironment, { kind: 'ok', data: { environment: 'staging' } }]]),
        );
        render(<App apiClient={apiClient} />);
        expect(await screen.findByRole('heading', { name: 'Vaše enginy' })).toBeTruthy();
        expect(document.documentElement.lang).toBe('cs');
        expect(await screen.findByText('Prostředí: staging')).toBeTruthy();
    });
});
