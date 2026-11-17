import { OWNER_PERMISSIONS } from '@ptbk/engine-api';
import type { InMemorySeedAccessRequest } from '@ptbk/engine-api/in-memory';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createFakePopups } from '../../testing/fake-popups';
import { createMemoryStorage } from '../../testing/memory-storage';
import { createSecurityEngine } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';
import { STEP_UP_INTENT_KEY } from '../step-up/step-up-intent';

const TIMEOUT_MS = 20_000;
const CODE = '482913';

const petr: InMemorySeedAccessRequest = {
    request: {
        id: 'access-petr',
        displayName: 'Petr Svoboda',
        email: 'petr@example.com',
        proposedRole: 'member',
        createdAt: '2026-09-30T09:00:00Z',
        expiresAt: '2026-10-07T09:00:00Z',
    },
    code: CODE,
    dashboardUserId: 'dashboard-user-petr',
};

function engineWithRequest(options: { permissions?: readonly Permission[]; stepUp?: 'required' } = {}) {
    return createSecurityEngine({ ...options, seed: { members: [], accessRequests: [petr] } });
}

type User = ReturnType<typeof renderWithProviders>['user'];

/** Picks an option from a `Combobox`: open its list, then choose by the option's name. */
async function pick(user: User, combobox: HTMLElement, option: string | RegExp) {
    await user.click(combobox);
    await user.click(screen.getByRole('option', { name: option }));
}

const codeInput = (dialog: HTMLElement) => within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Code/ });

async function openApprove(user: User) {
    const section = await screen.findByRole('region', { name: 'Access requests' });
    await user.click(within(section).getByRole('button', { name: 'Approve' }));
    return screen.getByRole('dialog', { name: 'Approve Petr Svoboda' });
}

describe('access requests', { timeout: TIMEOUT_MS }, () => {
    it('lets a person in with the code they read out, and badges the nav until then', async () => {
        const engine = engineWithRequest();
        const approve = vi.spyOn(engine.client.members, 'approveAccessRequest');
        const { user, container } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const section = await screen.findByRole('region', { name: 'Access requests' });
        expect(section.textContent).toContain('petr@example.com');
        expect(section.textContent).toContain('Suggested role: Member');
        expect(await screen.findByText('1 waiting')).toBeDefined();

        const dialog = await openApprove(user);
        expect(dialog.textContent).toContain('6-digit code');
        expect(dialog.textContent).toContain('petr@example.com, as reported by your organization');
        await pick(user, within(dialog).getByRole('combobox', { name: 'Role' }), 'Viewer');
        await expectNoAxeViolations(container);
        // The sixth digit approves: no button to find after reading the code out.
        await user.type(codeInput(dialog), CODE);

        expect(await screen.findByText('Petr Svoboda can now use this engine')).toBeDefined();
        expect(approve).toHaveBeenCalledExactlyOnceWith(
            'access-petr',
            { code: CODE, role: 'viewer' },
            expect.any(AbortSignal),
        );
        await waitFor(() => {
            expect(screen.queryByRole('region', { name: 'Access requests' })).toBeNull();
        });
        expect(await screen.findByText('via organization')).toBeDefined();
        expect(screen.queryByText('1 waiting')).toBeNull();
    });

    it('keeps the dialog open on a wrong code, says how many tries remain, and clears the cells', async () => {
        const engine = engineWithRequest();
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        await user.type(codeInput(dialog), '000000');
        expect(
            await within(dialog).findByText(
                "That code doesn't match. Check it with Petr Svoboda: 4 tries left before the request is removed.",
            ),
        ).toBeDefined();
        expect(codeInput(dialog).value).toBe('');
        expect(document.activeElement).toBe(codeInput(dialog));
        expect(engine.controller.inspect().members.map(({ displayName }) => displayName)).not.toContain('Petr Svoboda');
    });

    it('falls back to the general warning when the engine does not count the tries', async () => {
        const engine = engineWithRequest();
        vi.spyOn(engine.client.members, 'approveAccessRequest').mockImplementation(() =>
            problemResponse('access-code-mismatch'),
        );
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        await user.type(codeInput(dialog), '000000');
        expect(
            await within(dialog).findByText(
                /^That code doesn't match\. Check it with Petr Svoboda\. After 5 wrong codes/,
            ),
        ).toBeDefined();
    });

    it('takes a pasted code with its space, keeps digits only, and approves at once', async () => {
        const engine = engineWithRequest();
        const approve = vi.spyOn(engine.client.members, 'approveAccessRequest');
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        expect(document.activeElement).toBe(codeInput(dialog));
        await user.type(codeInput(dialog), 'a1b');
        expect(codeInput(dialog).value).toBe('1');
        await user.clear(codeInput(dialog));
        await user.paste('482 913');
        expect(await screen.findByText('Petr Svoboda can now use this engine')).toBeDefined();
        expect(approve).toHaveBeenCalledExactlyOnceWith(
            'access-petr',
            { code: CODE, role: 'member' },
            expect.any(AbortSignal),
        );
    });

    it('says the request was removed after the last wrong code, and offers nothing more to approve', async () => {
        const engine = engineWithRequest();
        const approve = vi.spyOn(engine.client.members, 'approveAccessRequest');
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            await user.type(codeInput(dialog), '000000');
            await waitFor(() => {
                expect(approve).toHaveBeenCalledTimes(attempt);
            });
            if (attempt < 5) await within(dialog).findByText(new RegExp(`: ${String(5 - attempt)} tr(y|ies) left`));
        }
        const removed = await screen.findByRole('dialog', { name: 'Approve Petr Svoboda' });
        expect(
            await within(removed).findByText(
                "Too many wrong codes, so Petr Svoboda's request was removed. Ask them to open the engine from the dashboard again.",
            ),
        ).toBeDefined();
        expect(within(removed).queryByRole('textbox', { name: /Code/ })).toBeNull();
        expect(within(removed).queryByRole('button', { name: 'Approve' })).toBeNull();
        await user.click(within(removed).getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
        await waitFor(() => {
            expect(screen.queryByRole('dialog')).toBeNull();
        });
    });

    it('shows who asks and the role they would get, with Approve as the one action and Decline in the menu', async () => {
        const { user } = renderWithProviders({ path: '/members', engineApi: engineWithRequest().client });
        const section = await screen.findByRole('region', { name: 'Access requests' });
        const row = within(section).getByText('Petr Svoboda').closest('li') as HTMLElement;
        expect(within(row).getByText('Suggested role: Member')).toBeDefined();
        expect(within(row).getByText(/petr@example\.com/)).toBeDefined();
        expect(
            within(row)
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label') ?? button.textContent),
        ).toEqual(['Approve', 'More actions for Petr Svoboda']);
        const dialog = await openApprove(user);
        const code = codeInput(dialog);
        expect(code.getAttribute('inputmode')).toBe('numeric');
        expect(code.getAttribute('aria-describedby')).toContain(
            within(dialog).getByText(/^The 6 digits they read out to you\./).id,
        );
    });

    it('asks for the 6 digits before calling the engine', async () => {
        const engine = engineWithRequest();
        const approve = vi.spyOn(engine.client.members, 'approveAccessRequest');
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        await user.type(codeInput(dialog), '12a');
        await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
        expect(within(dialog).getByText('Enter the 6 digits.')).toBeDefined();
        expect(approve).not.toHaveBeenCalled();
    });

    it('asks for a fresh passkey before approving, and lets nobody in', async () => {
        const engine = engineWithRequest({ stepUp: 'required' });
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        await user.type(codeInput(dialog), CODE);
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        expect(engine.controller.inspect().members.map(({ displayName }) => displayName)).not.toContain('Petr Svoboda');
    });

    it('approves once the passkey is confirmed in the popup, with the code typed before', async () => {
        const engine = engineWithRequest();
        const approve = vi
            .spyOn(engine.client.members, 'approveAccessRequest')
            .mockImplementationOnce(() => problemResponse('step-up-required'));
        const popups = createFakePopups();
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client, popups });
        const dialog = await openApprove(user);
        await user.type(codeInput(dialog), CODE);
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await user.click(within(stepUp).getByRole('button', { name: 'Continue with passkey' }));
        popups.confirm();
        expect(await screen.findByText('Petr Svoboda can now use this engine')).toBeDefined();
        expect(approve).toHaveBeenCalledTimes(2);
        expect(approve.mock.calls[1]?.slice(0, 2)).toEqual(['access-petr', { code: CODE, role: 'member' }]);
    });

    it('asks for the code again after a full-page step-up, which never stores it', async () => {
        const storage = createMemoryStorage();
        const engine = engineWithRequest({ stepUp: 'required' });
        const first = renderWithProviders({
            path: '/members',
            engineApi: engine.client,
            storage,
            popups: createFakePopups({ blocked: true }),
        });
        const dialog = await openApprove(first.user);
        await first.user.type(codeInput(dialog), CODE);
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await first.user.click(within(stepUp).getByRole('button', { name: 'Continue with passkey' }));
        expect(first.location.assign).toHaveBeenCalledOnce();
        expect(storage.getItem(STEP_UP_INTENT_KEY)).not.toContain(CODE);
        first.unmount();

        renderWithProviders({ path: '/members', engineApi: engine.client, storage });
        const resumed = await screen.findByRole('dialog', { name: 'Approve Petr Svoboda' });
        expect(within(resumed).getByText('Confirmed. Enter the code again to approve.')).toBeDefined();
        expect(codeInput(resumed).value).toBe('');
    });

    it('declines a request from its menu', async () => {
        const engine = engineWithRequest();
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'More actions for Petr Svoboda' }));
        await user.click(screen.getByRole('menuitem', { name: 'Decline' }));
        expect(await screen.findByText("Declined Petr Svoboda's request")).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByRole('region', { name: 'Access requests' })).toBeNull();
        });
    });

    it('opens the approval from a ?request= link, which still waits for the code', async () => {
        const engine = engineWithRequest();
        const approve = vi.spyOn(engine.client.members, 'approveAccessRequest');
        const { user, router } = renderWithProviders({
            path: '/members?request=access-petr',
            engineApi: engine.client,
        });
        const dialog = await screen.findByRole('dialog', { name: 'Approve Petr Svoboda' });
        await waitFor(() => {
            expect(document.activeElement).toBe(codeInput(dialog));
        });
        expect(approve).not.toHaveBeenCalled();
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => {
            expect(screen.queryByRole('dialog')).toBeNull();
        });
        expect(router.state.location.search).toEqual({});
    });

    it('says a linked request is no longer waiting', async () => {
        const engine = engineWithRequest();
        renderWithProviders({ path: '/members?request=access-gone', engineApi: engine.client });
        const dialog = await screen.findByRole('dialog', { name: 'This request is no longer waiting' });
        expect(within(dialog).queryByRole('textbox')).toBeNull();
    });

    it('ignores a ?request= link without members.manage', async () => {
        const permissions = OWNER_PERMISSIONS.filter((permission) => permission !== 'members.manage');
        renderWithProviders({
            path: '/members?request=access-petr',
            engineApi: engineWithRequest({ permissions }).client,
        });
        await screen.findByRole('region', { name: 'Access requests' });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('lists requests without approving or declining them, and no badge, without members.manage', async () => {
        const permissions = OWNER_PERMISSIONS.filter((permission) => permission !== 'members.manage');
        renderWithProviders({ path: '/members', engineApi: engineWithRequest({ permissions }).client });
        const section = await screen.findByRole('region', { name: 'Access requests' });
        expect(within(section).queryByRole('button', { name: 'Approve' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'More actions for Petr Svoboda' })).toBeNull();
        expect(screen.queryByText('1 waiting')).toBeNull();
    });
});

describe('dashboard removals', { timeout: TIMEOUT_MS }, () => {
    const toggle = () =>
        screen.findByRole('switch', { name: 'Let the organization remove members from the dashboard' });

    it('turns removals from the dashboard off and says so', async () => {
        const engine = createSecurityEngine();
        const { user, container } = renderWithProviders({ path: '/security', engineApi: engine.client });
        const control = await toggle();
        expect((control as HTMLInputElement).checked).toBe(true);
        await expectNoAxeViolations(container);
        await user.click(control);
        expect(await screen.findByText('Only this engine can remove members now')).toBeDefined();
        await waitFor(() => {
            expect(screen.getByRole<HTMLInputElement>('switch').checked).toBe(false);
        });
    });

    it('asks for a fresh passkey before changing it', async () => {
        const engine = createSecurityEngine({ stepUp: 'required' });
        const { user } = renderWithProviders({ path: '/security', engineApi: engine.client });
        await user.click(await toggle());
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        await waitFor(() => {
            expect(screen.getByRole<HTMLInputElement>('switch').checked).toBe(true);
        });
    });

    it('is not offered without settings.manage', async () => {
        const permissions = OWNER_PERMISSIONS.filter((permission) => permission !== 'settings.manage');
        renderWithProviders({ path: '/security', engineApi: createSecurityEngine({ permissions }).client });
        expect(await screen.findByText('Passkeys')).toBeDefined();
        expect(screen.queryByRole('switch')).toBeNull();
    });
});
