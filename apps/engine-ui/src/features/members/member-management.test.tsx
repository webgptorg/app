import { OWNER_PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const AT = '2026-09-01T00:00:00Z';

const member = (id: string, displayName: string, role: 'owner' | 'admin' | 'member' | 'viewer') => ({
    id,
    displayName,
    role,
    status: 'active' as const,
    createdAt: AT,
    lastSeenAt: null,
});

function teamEngine(
    options: {
        permissions?: readonly Permission[];
        stepUp?: 'required';
        alone?: boolean;
        invites?: boolean;
        dashboardUrl?: string | null;
    } = {},
) {
    return createSecurityEngine({
        ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
        ...(options.stepUp === undefined ? {} : { stepUp: options.stepUp }),
        seed: {
            engine: {
                name: 'Test engine',
                hostname: 'engine.localhost',
                dashboardUrl: options.dashboardUrl === undefined ? 'https://app.ptbk.io' : options.dashboardUrl,
                mode: 'tunnel',
            },
            members: options.alone
                ? []
                : [
                      member('member-jana', 'Jana Nováková', 'admin'),
                      member('member-petr', 'Petr Svoboda', 'member'),
                      member('member-eva', 'Eva Dvořáková', 'owner'),
                  ],
            invites: options.invites
                ? [
                      {
                          id: 'invite-viewer',
                          role: 'viewer',
                          createdBy: 'member-jana',
                          createdAt: '2026-09-19T10:00:00Z',
                          expiresAt: '2026-09-26T10:00:00Z',
                      },
                  ]
                : [],
        },
    });
}

type User = ReturnType<typeof renderWithProviders>['user'];

/** Picks an option from a `Combobox`: open its list, then choose by the option's name. */
async function pick(user: User, combobox: HTMLElement, option: string | RegExp) {
    await user.click(combobox);
    await user.click(screen.getByRole('option', { name: option }));
}

async function openRowMenu(user: User, label: string) {
    await user.click(await screen.findByRole('button', { name: `Actions for ${label}` }));
    return screen.getByRole('menu', { name: `Actions for ${label}` });
}

async function pickMenuItem(user: User, label: string, item: string) {
    await user.click(within(await openRowMenu(user, label)).getByRole('menuitem', { name: item }));
}

const roleCell = (name: string) => (screen.getByText(name).closest('tr') as HTMLElement).textContent;

describe('member management', { timeout: TIMEOUT_MS }, () => {
    it("changes a member's role after naming them, and says so", async () => {
        const engine = teamEngine();
        const update = vi.spyOn(engine.client.members, 'update');
        const { user, container } = renderWithProviders({ path: '/members', engineApi: engine.client });
        await pickMenuItem(user, 'Petr Svoboda', 'Change role');
        const dialog = screen.getByRole('dialog', { name: "Change Petr Svoboda's role" });
        const confirm = within(dialog).getByRole('button', { name: 'Change role' });
        expect(confirm.hasAttribute('disabled')).toBe(true);
        await pick(user, within(dialog).getByRole('combobox', { name: 'Role' }), 'Viewer');
        await expectNoAxeViolations(container);
        await user.click(confirm);
        expect(await screen.findByText("Changed Petr Svoboda's role to Viewer")).toBeDefined();
        await waitFor(() => {
            expect(roleCell('Petr Svoboda')).toContain('Viewer');
        });
        expect(update).toHaveBeenCalledExactlyOnceWith('member-petr', { role: 'viewer' }, expect.any(AbortSignal));
    });

    it('removes a member after a confirmation naming them', async () => {
        const engine = teamEngine();
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        await pickMenuItem(user, 'Petr Svoboda', 'Remove');
        const dialog = screen.getByRole('dialog', { name: 'Remove Petr Svoboda?' });
        expect(dialog.textContent).toContain('signed out on every device');
        await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
        expect(await screen.findByText('Removed Petr Svoboda')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByRole('cell', { name: /Petr Svoboda/ })).toBeNull();
        });
        expect(engine.controller.inspect().members.map(({ id }) => id)).not.toContain('member-petr');
    });

    it('offers no actions on your own row', async () => {
        renderWithProviders({ path: '/members', engineApi: teamEngine().client });
        await screen.findByText('Petr Svoboda');
        expect(screen.queryByRole('button', { name: 'Actions for Owner' })).toBeNull();
    });

    it('offers no invite, role change or removal without members.manage', async () => {
        const permissions = OWNER_PERMISSIONS.filter((permission) => permission !== 'members.manage');
        renderWithProviders({ path: '/members', engineApi: teamEngine({ permissions, invites: true }).client });
        expect(await screen.findByText('Invite as Viewer')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    });

    it('reports a refused role change as not allowed', async () => {
        const engine = teamEngine();
        vi.spyOn(engine.client.members, 'update').mockImplementation(() => problemResponse('forbidden'));
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        await pickMenuItem(user, 'Petr Svoboda', 'Change role');
        await pick(user, screen.getByRole('combobox', { name: 'Role' }), 'Admin');
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change role' }));
        expect(await screen.findByText('Not allowed')).toBeDefined();
        expect(roleCell('Petr Svoboda')).toContain('Member');
    });

    it('asks for a fresh passkey before a role change or a removal, and changes nothing', async () => {
        const engine = teamEngine({ stepUp: 'required' });
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        await pickMenuItem(user, 'Petr Svoboda', 'Remove');
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        expect(engine.controller.inspect().members.map(({ id }) => id)).toContain('member-petr');
    });
});

describe('invites', { timeout: TIMEOUT_MS }, () => {
    it('sends people to the dashboard to invite, and never creates an engine invite link', async () => {
        const engine = teamEngine();
        const create = vi.spyOn(engine.client.members, 'createInvite');
        const { container } = renderWithProviders({ path: '/members', engineApi: engine.client });
        const invite = await screen.findByRole('link', { name: /^Invite in the dashboard/ });
        expect(invite.getAttribute('href')).toBe('https://app.ptbk.io/');
        expect(invite.getAttribute('target')).toBe('_blank');
        expect(invite.getAttribute('rel')).toBe('noopener noreferrer');
        expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
        expect(screen.queryByText('Create invite link')).toBeNull();
        await expectNoAxeViolations(container);
        expect(create).not.toHaveBeenCalled();
    });

    it('offers no invite link while the engine reports no dashboard, since the bundle names no outside origin', async () => {
        renderWithProviders({ path: '/members', engineApi: teamEngine({ dashboardUrl: null }).client });
        expect(await screen.findByText('Petr Svoboda')).toBeDefined();
        expect(screen.queryByRole('link', { name: /^Invite in the dashboard/ })).toBeNull();
    });

    it('revokes a pending invite after confirmation', async () => {
        const engine = teamEngine({ invites: true });
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        expect(await screen.findByText('Invite as Viewer')).toBeDefined();
        await waitFor(() => {
            expect(screen.getByText('Invite as Viewer').closest('li')?.textContent).toContain('Jana Nováková');
        });
        await pickMenuItem(user, 'Invite as Viewer', 'Revoke invite');
        const dialog = screen.getByRole('dialog', { name: 'Revoke the invite as Viewer?' });
        await user.click(within(dialog).getByRole('button', { name: 'Revoke invite' }));
        expect(await screen.findByText('Revoked the invite as Viewer')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByText('Invite as Viewer')).toBeNull();
        });
    });

    it('points to the dashboard from the empty state when you are alone', async () => {
        renderWithProviders({ path: '/members', engineApi: teamEngine({ alone: true }).client });
        const empty = (await screen.findByRole('heading', { name: 'Invite your team' })).parentElement as HTMLElement;
        const region = empty.closest('div') as HTMLElement;
        expect(within(region).getByText(/They ask for access here/)).toBeDefined();
        expect(
            within(region)
                .getByRole('link', { name: /^Invite in the dashboard/ })
                .getAttribute('href'),
        ).toBe('https://app.ptbk.io/');
    });

    it('offers no invite without members.manage', async () => {
        const permissions = OWNER_PERMISSIONS.filter((permission) => permission !== 'members.manage');
        renderWithProviders({ path: '/members', engineApi: teamEngine({ permissions }).client });
        expect(
            await screen.findByText('Owners and admins invite people from the dashboard and change their roles.'),
        ).toBeDefined();
        expect(screen.queryByRole('link', { name: /^Invite in the dashboard/ })).toBeNull();
    });

    it('hides invites on an engine that has not built them', async () => {
        const engine = teamEngine();
        vi.spyOn(engine.client.members, 'listInvites').mockImplementation(() => problemResponse('not-found'));
        renderWithProviders({ path: '/members', engineApi: engine.client });
        expect(await screen.findByText('This engine does not support invites and role changes yet.')).toBeDefined();
        expect(screen.queryByRole('heading', { name: 'Pending invites' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    });

    it('reads in Czech', async () => {
        renderWithProviders({ path: '/members', engineApi: teamEngine({ invites: true }).client, locale: 'cs' });
        expect(await screen.findByText('Pozvánka: Pozorovatel')).toBeDefined();
        expect(screen.getByRole('link', { name: /^Pozvat v dashboardu/ })).toBeDefined();
    });
});
