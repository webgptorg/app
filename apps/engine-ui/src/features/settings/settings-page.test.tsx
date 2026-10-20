import { THEME_STORAGE_KEY } from '@ptbk/ui';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../../app/locale-storage';
import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';

describe('settings', () => {
    it('changes language and theme for this device, to any member', async () => {
        const { user, storage, container } = renderWithProviders({ path: '/settings', permissions: [] });

        await user.selectOptions(await screen.findByRole('combobox', { name: 'Theme' }), 'dark');
        expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
        await waitFor(() => {
            expect(document.documentElement.classList.contains('dark')).toBe(true);
        });

        await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'cs');
        expect(await screen.findByRole('heading', { level: 1, name: 'Nastavení' })).toBeDefined();
        expect(storage.getItem(LOCALE_STORAGE_KEY)).toBe('cs');
        expect(screen.getByRole('option', { name: 'English' })).toBeDefined();
        await expectNoAxeViolations(container);
    });
});
