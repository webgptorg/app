import { OWNER_PERMISSIONS } from '@ptbk/engine-api';
import { THEME_STORAGE_KEY } from '@ptbk/ui';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../../app/locale-storage';
import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createMemoryStorage } from '../../testing/memory-storage';
import { createSecurityEngine } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;

function renderSettings(options: Parameters<typeof createSecurityEngine>[0] = {}) {
    const engine = createSecurityEngine(options);
    return { ...renderWithProviders({ path: '/settings', engineApi: engine.client }), engine };
}

const updatesCard = () => screen.getByRole('heading', { name: 'Updates' }).closest('section') as HTMLElement;

describe('settings', { timeout: TIMEOUT_MS }, () => {
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
        expect(screen.queryByRole('heading', { name: 'Aktualizace' })).toBeNull();
        await expectNoAxeViolations(container);
    });
});

describe('settings: updates', { timeout: TIMEOUT_MS }, () => {
    it('shows the running version and changes the policy', async () => {
        const { user, container } = renderSettings();
        const policy = await screen.findByRole('combobox', { name: 'Policy' });
        expect(within(updatesCard()).getByText('Up to date')).toBeDefined();
        await expectNoAxeViolations(container);

        await user.selectOptions(policy, 'pinned');
        const version = screen.getByRole('textbox', { name: /^Version/ });
        expect((version as HTMLInputElement).value).toBe('1.0.0');
        expect(version.getAttribute('placeholder')).toBeNull();
        expect(screen.getByText('This engine runs 1.0.0 now.')).toBeDefined();

        await user.clear(version);
        await user.type(version, 'nope');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        expect(await screen.findByText('Enter a version such as 1.4.0.')).toBeDefined();

        await user.clear(version);
        await user.type(version, '1.0.0');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        expect(await screen.findByText('Update policy set to Pinned to 1.0.0')).toBeDefined();
        expect(screen.getByText(/recorded in the audit log/)).toBeDefined();
    });

    it('asks for a fresh passkey when the engine wants step-up, and changes nothing', async () => {
        const { user, engine } = renderSettings({ stepUp: 'required' });
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Policy' }), 'manual');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        const overview = await engine.client.security.get(AbortSignal.timeout(1000));
        expect(overview.kind === 'ok' && overview.data.update.policy).toBe('auto');
    });

    it('brings the change back after the passkey check, for one more click', async () => {
        const storage = createMemoryStorage();
        const engine = createSecurityEngine({ stepUp: 'required' });
        const first = renderWithProviders({ path: '/settings', engineApi: engine.client, storage });
        await first.user.selectOptions(await screen.findByRole('combobox', { name: 'Policy' }), 'pinned');
        await first.user.click(screen.getByRole('button', { name: 'Save policy' }));
        const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await first.user.click(within(dialog).getByRole('button', { name: 'Continue with passkey' }));
        expect(first.location.assign).toHaveBeenCalledOnce();
        first.unmount();

        const save = vi.spyOn(engine.client.settings, 'setUpdatePolicy');
        renderWithProviders({ path: '/settings', engineApi: engine.client, storage });
        expect(
            await screen.findByText('You confirmed it is you. Check the change and save it once more.'),
        ).toBeDefined();
        expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Policy' }).value).toBe('pinned');
        expect(screen.getByRole<HTMLInputElement>('textbox', { name: /^Version/ }).value).toBe('1.0.0');
        expect(save).not.toHaveBeenCalled();
    });

    it('reports a refused change', async () => {
        const { user, engine } = renderSettings();
        vi.spyOn(engine.client.settings, 'setUpdatePolicy').mockImplementation(() => problemResponse('internal-error'));
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Policy' }), 'manual');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        expect(await screen.findByText('The update policy could not be changed.')).toBeDefined();
    });

    it('is read-only without settings.manage', async () => {
        renderSettings({ permissions: OWNER_PERMISSIONS.filter((permission) => permission !== 'settings.manage') });
        await screen.findByRole('heading', { name: 'Updates' });
        await within(updatesCard()).findByText('Automatic');
        expect(within(updatesCard()).queryByRole('combobox')).toBeNull();
        expect(within(updatesCard()).queryByRole('button')).toBeNull();
    });

    it('is left out without security.read, and the overview is never asked for', async () => {
        const engine = createSecurityEngine({
            permissions: OWNER_PERMISSIONS.filter((permission) => permission !== 'security.read'),
        });
        const get = vi.spyOn(engine.client.security, 'get');
        renderWithProviders({ path: '/settings', engineApi: engine.client });
        await screen.findByRole('combobox', { name: 'Theme' });
        expect(screen.queryByRole('heading', { name: 'Updates' })).toBeNull();
        expect(get).not.toHaveBeenCalled();
    });
});
