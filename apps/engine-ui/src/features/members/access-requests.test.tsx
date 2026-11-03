import { OWNER_PERMISSIONS } from '@ptbk/engine-api';
import type { InMemorySeedAccessRequest } from '@ptbk/engine-api/in-memory';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine } from '../../testing/security-engine';

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
        await user.type(within(dialog).getByRole('textbox', { name: /Code/ }), CODE);
        await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role' }), 'viewer');
        await expectNoAxeViolations(container);
        await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

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

    it('keeps the dialog open on a wrong code and says to check it with the person', async () => {
        const engine = engineWithRequest();
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        await user.type(within(dialog).getByRole('textbox', { name: /Code/ }), '000000');
        await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
        expect(
            await within(dialog).findByText(
                /^That code doesn't match\. Check it with Petr Svoboda\. After 5 wrong codes/,
            ),
        ).toBeDefined();
        expect(engine.controller.inspect().members.map(({ displayName }) => displayName)).not.toContain('Petr Svoboda');
    });

    it('says the request was removed after the last wrong code, and offers nothing more to approve', async () => {
        const engine = engineWithRequest();
        const approve = vi.spyOn(engine.client.members, 'approveAccessRequest');
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        const input = within(dialog).getByRole('textbox', { name: /Code/ });
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            await user.clear(input);
            await user.type(input, '000000');
            await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
            await waitFor(() => {
                expect(approve).toHaveBeenCalledTimes(attempt);
            });
            if (attempt < 5) await within(dialog).findByText(/^That code doesn't match/);
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

    it('asks for the 6 digits before calling the engine', async () => {
        const engine = engineWithRequest();
        const approve = vi.spyOn(engine.client.members, 'approveAccessRequest');
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        await user.type(within(dialog).getByRole('textbox', { name: /Code/ }), '12a');
        await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
        expect(within(dialog).getByText('Enter the 6 digits.')).toBeDefined();
        expect(approve).not.toHaveBeenCalled();
    });

    it('asks for a fresh passkey before approving, and lets nobody in', async () => {
        const engine = engineWithRequest({ stepUp: 'required' });
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const dialog = await openApprove(user);
        await user.type(within(dialog).getByRole('textbox', { name: /Code/ }), CODE);
        await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        expect(engine.controller.inspect().members.map(({ displayName }) => displayName)).not.toContain('Petr Svoboda');
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
