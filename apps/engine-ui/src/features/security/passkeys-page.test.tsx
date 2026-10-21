import { OWNER_PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine, OWNER_ID } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const AT = '2026-09-20T10:00:00Z';

interface Authenticator {
    readonly attachment: 'platform' | 'cross-platform' | null;
    readonly backedUp: boolean | null;
}

const passkey = (
    id: string,
    memberId: string,
    name: string,
    createdAt: string,
    authenticator: Authenticator | null,
) => ({
    id,
    memberId,
    name,
    createdAt,
    lastUsedAt: null,
    authenticator,
});

function passkeysEngine(options: { permissions?: readonly Permission[]; stepUp?: 'required' } = {}) {
    return createSecurityEngine({
        ...options,
        seed: {
            members: [
                {
                    id: 'member-jana',
                    displayName: 'Jana Nováková',
                    role: 'admin',
                    status: 'active',
                    createdAt: AT,
                    lastSeenAt: null,
                },
            ],
            passkeys: [
                passkey('pk-laptop', OWNER_ID, 'MacBook', '2026-09-03T00:00:00Z', {
                    attachment: 'platform',
                    backedUp: true,
                }),
                passkey('pk-key', OWNER_ID, 'YubiKey', '2026-09-02T00:00:00Z', {
                    attachment: 'cross-platform',
                    backedUp: false,
                }),
                passkey('pk-jana', 'member-jana', 'Jana phone', '2026-09-01T00:00:00Z', null),
                passkey('pk-jana-2', 'member-jana', 'Jana laptop', '2026-08-01T00:00:00Z', null),
            ],
            sessions: [
                {
                    id: 'session-current',
                    memberId: OWNER_ID,
                    current: true,
                    client: null,
                    passkeyId: 'pk-laptop',
                    createdAt: AT,
                    lastSeenAt: AT,
                    expiresAt: '2026-10-02T00:00:00Z',
                },
            ],
        },
    });
}

const mine = () => screen.getByRole('heading', { name: 'Your passkeys' }).closest('section') as HTMLElement;
const rowOf = (container: HTMLElement, name: string) => within(container).getByText(name).closest('li') as HTMLElement;

describe('passkeys', { timeout: TIMEOUT_MS }, () => {
    it("lists the member's passkeys with their kind, marks the current one, and passes axe", async () => {
        const { container } = renderWithProviders({ path: '/settings/passkeys', engineApi: passkeysEngine().client });
        await screen.findAllByText('MacBook');
        expect(rowOf(mine(), 'MacBook').textContent).toContain('Built into a device, synced');
        expect(rowOf(mine(), 'MacBook').textContent).toContain('Signed in with this one');
        expect(rowOf(mine(), 'YubiKey').textContent).toContain('Security key or phone, this device only');
        expect(within(mine()).queryByText('Jana phone')).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('revokes after confirmation, and reports it', async () => {
        const engine = passkeysEngine();
        const revoke = vi.spyOn(engine.client.me, 'revokePasskey');
        const { user } = renderWithProviders({ path: '/settings/passkeys', engineApi: engine.client });
        await screen.findAllByText('YubiKey');
        await user.click(within(rowOf(mine(), 'YubiKey')).getByRole('button', { name: /Revoke/ }));
        const dialog = screen.getByRole('dialog', { name: 'Revoke YubiKey?' });
        expect(revoke).not.toHaveBeenCalled();
        expect(dialog.textContent).not.toContain('signed out');
        await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
        expect(await screen.findByText('Passkey YubiKey revoked')).toBeDefined();
        await waitFor(() => {
            expect(within(mine()).queryByText('YubiKey')).toBeNull();
        });
        expect(revoke).toHaveBeenCalledOnce();
    });

    it('warns that revoking the passkey of this session signs you out', async () => {
        const { user } = renderWithProviders({ path: '/settings/passkeys', engineApi: passkeysEngine().client });
        await screen.findAllByText('MacBook');
        await waitFor(() => {
            expect(rowOf(mine(), 'MacBook').textContent).toContain('Signed in with this one');
        });
        await user.click(within(rowOf(mine(), 'MacBook')).getByRole('button', { name: /Revoke/ }));
        const dialog = screen.getByRole('dialog', { name: 'Revoke MacBook?' });
        expect(dialog.textContent).toContain('you will be signed out here');
        expect(within(dialog).getByRole('button', { name: 'Revoke and sign out' })).toBeDefined();
    });

    it('asks for a fresh passkey when the engine wants step-up', async () => {
        const { user } = renderWithProviders({
            path: '/settings/passkeys',
            engineApi: passkeysEngine({ stepUp: 'required' }).client,
        });
        await screen.findAllByText('YubiKey');
        await user.click(within(rowOf(mine(), 'YubiKey')).getByRole('button', { name: /Revoke/ }));
        await user.click(
            within(screen.getByRole('dialog', { name: 'Revoke YubiKey?' })).getByRole('button', { name: 'Revoke' }),
        );
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        expect(within(mine()).getByText('YubiKey')).toBeDefined();
    });

    it('explains that the last passkey cannot be revoked', async () => {
        const engine = passkeysEngine();
        vi.spyOn(engine.client.me, 'revokePasskey').mockImplementation(() => problemResponse('last-passkey'));
        const { user } = renderWithProviders({ path: '/settings/passkeys', engineApi: engine.client });
        await screen.findAllByText('YubiKey');
        await user.click(within(rowOf(mine(), 'YubiKey')).getByRole('button', { name: /Revoke/ }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
        expect(await screen.findByText('YubiKey is the last passkey, so it cannot be revoked.')).toBeDefined();
    });

    it("shows and revokes every member's passkeys with members.manage", async () => {
        const engine = passkeysEngine();
        const revoke = vi.spyOn(engine.client.passkeys, 'revoke');
        const { user } = renderWithProviders({ path: '/settings/passkeys', engineApi: engine.client });
        const everyone = (await screen.findByRole('heading', { name: "All members' passkeys" })).closest(
            'section',
        ) as HTMLElement;
        const jana = await within(everyone).findByText('Jana phone');
        await waitFor(() => {
            expect(jana.closest('li')?.textContent).toContain('Jana Nováková');
        });
        expect(jana.closest('li')?.textContent).toContain('Unknown authenticator');
        await user.click(within(jana.closest('li') as HTMLElement).getByRole('button', { name: /Revoke/ }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
        expect(await screen.findByText('Passkey Jana phone revoked')).toBeDefined();
        expect(revoke).toHaveBeenCalledOnce();
    });

    it("shows only the member's own passkeys without members.manage", async () => {
        const permissions = OWNER_PERMISSIONS.filter((permission) => permission !== 'members.manage');
        renderWithProviders({ path: '/settings/passkeys', engineApi: passkeysEngine({ permissions }).client });
        await screen.findAllByText('MacBook');
        expect(screen.queryByRole('heading', { name: "All members' passkeys" })).toBeNull();
    });

    it('is reachable from the settings page, also with no permission at all', async () => {
        const { user, router } = renderWithProviders({
            path: '/settings',
            engineApi: passkeysEngine({ permissions: [] }).client,
        });
        await user.click(await screen.findByRole('link', { name: 'Manage passkeys' }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/settings/passkeys');
        });
        expect(await screen.findAllByText('MacBook')).not.toHaveLength(0);
    });

    it('shows an error with retry when the list fails', async () => {
        const engine = passkeysEngine();
        const list = vi
            .spyOn(engine.client.me, 'listPasskeys')
            .mockImplementation(() => problemResponse('internal-error'));
        const { user } = renderWithProviders({ path: '/settings/passkeys', engineApi: engine.client });
        const retry = await within(await waitFor(() => mine())).findByRole(
            'button',
            { name: 'Try again' },
            { timeout: 10_000 },
        );
        list.mockRestore();
        await user.click(retry);
        expect(await screen.findAllByText('MacBook')).not.toHaveLength(0);
    });
});
