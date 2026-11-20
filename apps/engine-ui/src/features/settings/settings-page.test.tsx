import { OWNER_PERMISSIONS } from '@ptbk/engine-api';
import { THEME_STORAGE_KEY } from '@ptbk/ui';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../../app/locale-storage';
import { STEP_UP_INTENT_KEY } from '../step-up/step-up-intent';
import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createFakePopups } from '../../testing/fake-popups';
import { createMemoryStorage } from '../../testing/memory-storage';
import { createSecurityEngine } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;

function renderSettings(options: Parameters<typeof createSecurityEngine>[0] = {}) {
    const engine = createSecurityEngine(options);
    return { ...renderWithProviders({ path: '/settings', engineApi: engine.client }), engine };
}

type User = ReturnType<typeof renderWithProviders>['user'];

/** Picks an option the way a member does: open the combobox, click the option. */
async function choose(user: User, name: string, option: string | RegExp) {
    await user.click(await screen.findByRole('combobox', { name }));
    await user.click(await screen.findByRole('option', { name: option }));
}

const updatesCard = () => screen.getByRole('heading', { name: 'Updates' }).closest('section') as HTMLElement;

describe('settings', { timeout: TIMEOUT_MS }, () => {
    it('changes language and theme for this device, to any member', async () => {
        const { user, storage, container } = renderWithProviders({ path: '/settings', permissions: [] });

        await choose(user, 'Theme', 'Dark');
        expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
        await waitFor(() => {
            expect(document.documentElement.classList.contains('dark')).toBe(true);
        });

        await choose(user, 'Language', 'Čeština');
        expect(await screen.findByRole('heading', { level: 1, name: 'Nastavení' })).toBeDefined();
        expect(storage.getItem(LOCALE_STORAGE_KEY)).toBe('cs');
        // Each language keeps its own name, so the way back reads the same in any language.
        expect(screen.getByRole('combobox', { name: 'Jazyk' }).textContent).toBe('Čeština');
        expect(screen.getByRole('combobox', { name: 'Jazyk' }).querySelector('[lang="cs"]')).not.toBeNull();
        await user.click(screen.getByRole('combobox', { name: 'Jazyk' }));
        expect(await screen.findByRole('option', { name: 'English' })).toBeDefined();
        expect(screen.queryByRole('heading', { name: 'Aktualizace' })).toBeNull();
        await expectNoAxeViolations(container);
    });
});

describe('settings: updates', { timeout: TIMEOUT_MS }, () => {
    it('shows the running version and changes the policy', async () => {
        const { user, container } = renderSettings();
        await screen.findByRole('combobox', { name: 'Policy' });
        expect(within(updatesCard()).getByText('Up to date')).toBeDefined();
        await expectNoAxeViolations(container);

        await choose(user, 'Policy', 'Pinned to a version');
        const version = screen.getByRole('textbox', { name: /^Version/ });
        expect((version as HTMLInputElement).value).toBe('1.0.0');
        expect(version.getAttribute('placeholder')).toBeNull();
        expect(screen.getByText('This project runs 1.0.0 now.')).toBeDefined();

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

    it('offers the save only once the policy changed, and not again after changing it back', async () => {
        const { user } = renderSettings();
        await screen.findByRole('combobox', { name: 'Policy' });
        const save = screen.getByRole('button', { name: 'Save policy' });
        expect(save.hasAttribute('disabled')).toBe(true);
        await choose(user, 'Policy', 'Manual');
        expect(save.hasAttribute('disabled')).toBe(false);
        await choose(user, 'Policy', 'Automatic');
        expect(save.hasAttribute('disabled')).toBe(true);
    });

    it('asks for a fresh passkey when the engine wants step-up, and changes nothing', async () => {
        const { user, engine } = renderSettings({ stepUp: 'required' });
        await choose(user, 'Policy', 'Manual');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        const overview = await engine.client.security.get(AbortSignal.timeout(1000));
        expect(overview.kind === 'ok' && overview.data.update.policy).toBe('auto');
    });

    it('saves the change once the passkey is confirmed in the popup, without another click', async () => {
        const engine = createSecurityEngine();
        const save = vi
            .spyOn(engine.client.settings, 'setUpdatePolicy')
            .mockImplementationOnce(() => problemResponse('step-up-required'));
        const popups = createFakePopups();
        const { user } = renderWithProviders({ path: '/settings', engineApi: engine.client, popups });
        await choose(user, 'Policy', 'Manual');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await user.click(within(dialog).getByRole('button', { name: 'Continue with passkey' }));
        expect(within(dialog).getByText(/in the window that opened/)).toBeDefined();
        popups.confirm();
        expect(await screen.findByText(/^Update policy set to/)).toBeDefined();
        expect(save).toHaveBeenCalledTimes(2);
        expect(save.mock.calls[1]?.[0]).toEqual({ policy: 'manual' });
    });

    it('saves the change by itself on return when the popup was blocked, once and only while fresh', async () => {
        const storage = createMemoryStorage();
        const engine = createSecurityEngine();
        const save = vi
            .spyOn(engine.client.settings, 'setUpdatePolicy')
            .mockImplementationOnce(() => problemResponse('step-up-required'));
        const first = renderWithProviders({
            path: '/settings',
            engineApi: engine.client,
            storage,
            popups: createFakePopups({ blocked: true }),
        });
        await choose(first.user, 'Policy', 'Manual');
        await first.user.click(screen.getByRole('button', { name: 'Save policy' }));
        const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await first.user.click(within(dialog).getByRole('button', { name: 'Continue with passkey' }));
        expect(first.location.assign).toHaveBeenCalledOnce();
        first.unmount();

        const second = renderWithProviders({ path: '/settings', engineApi: engine.client, storage });
        expect(await screen.findByText(/^Update policy set to/)).toBeDefined();
        expect(save).toHaveBeenCalledTimes(2);
        expect(save.mock.calls[1]?.[0]).toEqual({ policy: 'manual' });
        second.unmount();

        renderWithProviders({ path: '/settings', engineApi: engine.client, storage });
        await screen.findByRole('button', { name: 'Save policy' });
        expect(save).toHaveBeenCalledTimes(2);
    });

    it('drops a saved change older than two minutes instead of saving it', async () => {
        const at = Date.now() - 3 * 60_000;
        const storage = createMemoryStorage({
            [STEP_UP_INTENT_KEY]: JSON.stringify({
                action: 'settings.update-policy',
                data: { policy: 'manual', pinnedVersion: '' },
                auto: true,
                path: '/settings',
                at,
            }),
        });
        const engine = createSecurityEngine();
        const save = vi.spyOn(engine.client.settings, 'setUpdatePolicy');
        renderWithProviders({ path: '/settings', engineApi: engine.client, storage });
        await screen.findByRole('button', { name: 'Save policy' });
        await waitFor(() => {
            expect(storage.getItem(STEP_UP_INTENT_KEY)).toBe('');
        });
        expect(save).not.toHaveBeenCalled();
    });

    it('says the passkey was not confirmed when the window is closed, and changes nothing', async () => {
        const engine = createSecurityEngine({ stepUp: 'required' });
        const save = vi.spyOn(engine.client.settings, 'setUpdatePolicy');
        const popups = createFakePopups();
        const { user } = renderWithProviders({ path: '/settings', engineApi: engine.client, popups });
        await choose(user, 'Policy', 'Manual');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await user.click(within(dialog).getByRole('button', { name: 'Continue with passkey' }));
        popups.opened[0]?.close();
        expect(await within(dialog).findByText(/^It wasn't confirmed/, {}, { timeout: 3_000 })).toBeDefined();
        await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
        expect(popups.open).toHaveBeenCalledTimes(2);
        expect(save).toHaveBeenCalledOnce();
    });

    it('reports a refused change', async () => {
        const { user, engine } = renderSettings();
        vi.spyOn(engine.client.settings, 'setUpdatePolicy').mockImplementation(() => problemResponse('internal-error'));
        await choose(user, 'Policy', 'Manual');
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
