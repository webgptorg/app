import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../shared/api/routes';
import { createFakeApiClient } from './api/fake-api-client';
import { App } from './app';

describe('app shell language switcher', () => {
    it('starts in English and switches to Czech without a reload, remembering it in the cookie', async () => {
        const apiClient = createFakeApiClient(
            new Map([[apiRoutes.getEnvironment, { kind: 'ok', data: { environment: 'production' } }]]),
        );
        render(<App apiClient={apiClient} />);
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
        expect(document.documentElement.lang).toBe('en');

        fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'cs' } });

        expect(await screen.findByRole('heading', { name: 'Vaše enginy' })).toBeTruthy();
        expect(document.documentElement.lang).toBe('cs');
        expect(document.cookie).toContain('ptbk_locale=cs');
        expect(screen.queryByText(/Environment|Prostředí/)).toBeNull();
    });
});
