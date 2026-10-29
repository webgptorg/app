import { OWNER_PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine, documentText } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const AT = '2026-09-01T00:00:00Z';
const ADMIN_PERMISSIONS = OWNER_PERMISSIONS.filter((permission) => permission !== 'settings.manage');

const member = (id: string, displayName: string, role: 'owner' | 'admin' | 'member' | 'viewer') => ({
    id,
    displayName,
    role,
    status: 'active' as const,
    createdAt: AT,
    lastSeenAt: null,
});

function teamEngine(
    options: { permissions?: readonly Permission[]; stepUp?: 'required'; alone?: boolean; invites?: boolean } = {},
) {
    return createSecurityEngine({
        ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
        ...(options.stepUp === undefined ? {} : { stepUp: options.stepUp }),
        seed: {
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
        await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role' }), 'viewer');
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

    it('lets only a member holding every permission act on an owner or grant the owner role', async () => {
        const admin = renderWithProviders({
            path: '/members',
            engineApi: teamEngine({ permissions: ADMIN_PERMISSIONS }).client,
        });
        await screen.findByText('Eva Dvořáková');
        expect(screen.queryByRole('button', { name: 'Actions for Eva Dvořáková' })).toBeNull();
        await pickMenuItem(admin.user, 'Petr Svoboda', 'Change role');
        const roles = within(screen.getByRole('dialog')).getAllByRole('option');
        expect(roles.map((option) => option.textContent)).toEqual(['Admin', 'Member', 'Viewer']);
        admin.unmount();

        const owner = renderWithProviders({ path: '/members', engineApi: teamEngine().client });
        await pickMenuItem(owner.user, 'Eva Dvořáková', 'Change role');
        expect(
            within(screen.getByRole('dialog'))
                .getAllByRole('option')
                .map((option) => option.textContent),
        ).toEqual(['Owner', 'Admin', 'Member', 'Viewer']);
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
        await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'admin');
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
    it('creates an invite link, shows it once, and keeps it out of the cache', async () => {
        const engine = teamEngine();
        const create = vi.spyOn(engine.client.members, 'createInvite');
        const { user, container, queryClient } = renderWithProviders({ path: '/members', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Invite member' }));
        const form = screen.getByRole('dialog', { name: 'Invite a member' });
        await user.selectOptions(within(form).getByRole('combobox', { name: 'Role' }), 'viewer');
        await user.selectOptions(within(form).getByRole('combobox', { name: 'Link works for' }), '1');
        await expectNoAxeViolations(container);
        await user.click(within(form).getByRole('button', { name: 'Create invite link' }));

        const shown = await screen.findByRole('dialog', { name: 'Invite link created' });
        expect(shown.textContent).toContain('join as Viewer');
        expect(shown.textContent).toContain('1 day');
        const link = within(shown).getByRole<HTMLInputElement>('textbox', { name: 'Invite link' });
        expect(link.value).toMatch(/^https:\/\/engine\.localhost\/auth\/invite#/);
        expect(within(shown).queryByRole('link')).toBeNull();
        const url = link.value;
        const body = create.mock.calls[0]?.[0];
        expect(body?.role).toBe('viewer');
        expect(new Date(body?.expiresAt ?? 0).getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60_000);

        await user.click(within(shown).getByRole('button', { name: 'Done' }));
        expect(await screen.findByText('Invite as Viewer')).toBeDefined();
        expect(documentText()).not.toContain(url);
        const cache = JSON.stringify([
            queryClient
                .getQueryCache()
                .getAll()
                .map((query) => query.state.data),
            queryClient
                .getMutationCache()
                .getAll()
                .map((mutation) => mutation.state.data),
        ]);
        expect(cache).not.toContain(url);
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

    it('asks for a fresh passkey before creating an invite, and shows no link', async () => {
        const { user } = renderWithProviders({
            path: '/members',
            engineApi: teamEngine({ stepUp: 'required' }).client,
        });
        await user.click(await screen.findByRole('button', { name: 'Invite member' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invite link' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        expect(screen.queryByRole('textbox', { name: 'Invite link' })).toBeNull();
    });

    it('invites the first teammate from an empty state when you are alone', async () => {
        const { user } = renderWithProviders({ path: '/members', engineApi: teamEngine({ alone: true }).client });
        const empty = (await screen.findByRole('heading', { name: 'Invite your team' })).parentElement as HTMLElement;
        await user.click(within(empty.closest('div') as HTMLElement).getByRole('button', { name: 'Invite member' }));
        expect(screen.getByRole('dialog', { name: 'Invite a member' })).toBeDefined();
    });

    it('hides invites on an engine that has not built them', async () => {
        const engine = teamEngine();
        vi.spyOn(engine.client.members, 'listInvites').mockImplementation(() => problemResponse('not-found'));
        renderWithProviders({ path: '/members', engineApi: engine.client });
        expect(await screen.findByText('This engine does not support invites and role changes yet.')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Pending invites' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    });

    it('reads in Czech', async () => {
        renderWithProviders({ path: '/members', engineApi: teamEngine({ invites: true }).client, locale: 'cs' });
        expect(await screen.findByText('Pozvánka: Pozorovatel')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Pozvat člena' })).toBeDefined();
    });
});
