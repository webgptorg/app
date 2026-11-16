import { SIGN_IN_PATH, SIGN_OUT_PATH } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine, OWNER_ID } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0';
const IPHONE_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const WINDOWS_EDGE =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

const session = (id: string, memberId: string, userAgent: string | null, lastSeenAt: string, current = false) => ({
    id,
    memberId,
    current,
    client: userAgent === null ? null : { ip: '203.0.113.7', userAgent },
    passkeyId: null,
    createdAt: '2026-09-01T08:00:00Z',
    lastSeenAt,
    expiresAt: '2026-12-01T00:00:00Z',
});

function sessionsEngine(options: { permissions?: readonly Permission[]; stepUp?: 'required' } = {}) {
    return createSecurityEngine({
        ...options,
        seed: {
            members: [
                {
                    id: 'member-jana',
                    displayName: 'Jana Nováková',
                    role: 'admin',
                    status: 'active',
                    createdAt: '2026-08-01T00:00:00Z',
                    lastSeenAt: null,
                },
            ],
            sessions: [
                session('session-current', OWNER_ID, MAC_FIREFOX, '2026-09-20T09:59:00Z', true),
                session('session-phone', OWNER_ID, IPHONE_SAFARI, '2026-09-19T18:00:00Z'),
                session('session-unknown', OWNER_ID, null, '2026-09-10T18:00:00Z'),
                session('session-jana', 'member-jana', WINDOWS_EDGE, '2026-09-20T09:00:00Z'),
            ],
        },
    });
}

const list = () =>
    screen.getByRole('heading', { name: /^Where you're signed in( \d+)?$/ }).closest('section') as HTMLElement;
const rowOf = (name: string) => within(list()).getByText(name).closest('li') as HTMLElement;

async function openRowMenu(user: ReturnType<typeof renderWithProviders>['user'], device: string) {
    await user.click(await screen.findByRole('button', { name: `Actions for ${device}` }));
    return screen.getByRole('menu', { name: `Actions for ${device}` });
}

describe('sessions', { timeout: TIMEOUT_MS }, () => {
    it("lists the member's own sessions by device, marks this one, and passes axe", async () => {
        const { container } = renderWithProviders({ path: '/security/sessions', engineApi: sessionsEngine().client });
        expect(await screen.findByText('Firefox on macOS')).toBeDefined();
        expect(rowOf('Firefox on macOS').textContent).toContain('This device');
        expect(rowOf('Safari on iOS').textContent).toContain('203.0.113.7');
        expect(rowOf('Safari on iOS').textContent).toContain('last active');
        expect(rowOf('Safari on iOS').textContent).not.toContain('This device');
        expect(rowOf('Unknown browser')).toBeDefined();
        expect(within(list()).queryByText('Edge on Windows')).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('reaches back to Security through the breadcrumb trail, with no "Back to" link', async () => {
        renderWithProviders({ path: '/security/sessions', engineApi: sessionsEngine().client });
        await screen.findByText('Firefox on macOS');
        const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
        expect(within(trail).getByRole('link', { name: 'Security' }).getAttribute('href')).toBe('/security');
        expect(screen.queryByRole('link', { name: /^Back to/ })).toBeNull();
    });

    it('signs one session out after a confirmation naming the device', async () => {
        const engine = sessionsEngine();
        const revoke = vi.spyOn(engine.client.me, 'revokeSession');
        const { user } = renderWithProviders({ path: '/security/sessions', engineApi: engine.client });
        const menu = await openRowMenu(user, 'Safari on iOS');
        await user.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
        const dialog = screen.getByRole('dialog', { name: 'Sign out Safari on iOS?' });
        expect(revoke).not.toHaveBeenCalled();
        await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
        expect(await screen.findByText('Signed out Safari on iOS')).toBeDefined();
        await waitFor(() => {
            expect(within(list()).queryByText('Safari on iOS')).toBeNull();
        });
        expect(revoke).toHaveBeenCalledExactlyOnceWith('session-phone', expect.any(AbortSignal));
        expect(engine.controller.inspect().sessions.map(({ id }) => id)).not.toContain('session-phone');
    });

    it('signs out every other session at once and keeps this one', async () => {
        const engine = sessionsEngine();
        const { user } = renderWithProviders({ path: '/security/sessions', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Sign out other sessions' }));
        const dialog = screen.getByRole('dialog', { name: 'Sign out 2 other sessions?' });
        await user.click(within(dialog).getByRole('button', { name: 'Sign out other sessions' }));
        expect(await screen.findByText('Signed out 2 other sessions')).toBeDefined();
        expect(await within(list()).findByText("You're signed in only on this device.")).toBeDefined();
        expect(within(list()).getByText('Firefox on macOS')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Sign out other sessions' })).toBeNull();
        expect(engine.controller.inspect().sessions.map(({ id }) => id)).toEqual(['session-current', 'session-jana']);
    });

    it('signs this device out through the gateway, not by revoking its session', async () => {
        const engine = sessionsEngine();
        const revoke = vi.spyOn(engine.client.me, 'revokeSession');
        const { user, fetch, location } = renderWithProviders({
            path: '/security/sessions',
            engineApi: engine.client,
        });
        const menu = await openRowMenu(user, 'Firefox on macOS');
        await user.click(within(menu).getByRole('menuitem', { name: 'Sign out here' }));
        await waitFor(() => {
            expect(location.assign).toHaveBeenCalledWith(SIGN_IN_PATH);
        });
        expect(fetch).toHaveBeenCalledWith(SIGN_OUT_PATH, expect.objectContaining({ method: 'POST' }));
        expect(revoke).not.toHaveBeenCalled();
    });

    it("is reachable from Security's access card and works with no permission at all", async () => {
        const engine = sessionsEngine({ permissions: [] });
        const { user, router } = renderWithProviders({ path: '/security', engineApi: engine.client });
        expect(await screen.findByText('Signed in on 3 devices')).toBeDefined();
        await user.click(screen.getByRole('link', { name: 'Manage sessions' }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/security/sessions');
        });
        await user.click(within(await openRowMenu(user, 'Safari on iOS')).getByRole('menuitem', { name: 'Sign out' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
        expect(await screen.findByText('Signed out Safari on iOS')).toBeDefined();
    });

    it('asks for a fresh passkey when the engine wants step-up, and keeps the session', async () => {
        const engine = sessionsEngine();
        vi.spyOn(engine.client.me, 'revokeSession').mockImplementation(() => problemResponse('step-up-required'));
        const { user } = renderWithProviders({ path: '/security/sessions', engineApi: engine.client });
        await user.click(within(await openRowMenu(user, 'Safari on iOS')).getByRole('menuitem', { name: 'Sign out' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        expect(within(list()).getByText('Safari on iOS')).toBeDefined();
        expect(engine.controller.inspect().sessions.map(({ id }) => id)).toContain('session-phone');
    });

    it('names the device when signing it out fails', async () => {
        const engine = sessionsEngine();
        vi.spyOn(engine.client.me, 'revokeSession').mockImplementation(() => problemResponse('not-found'));
        const { user } = renderWithProviders({ path: '/security/sessions', engineApi: engine.client });
        await user.click(within(await openRowMenu(user, 'Safari on iOS')).getByRole('menuitem', { name: 'Sign out' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
        expect(await screen.findByText('Safari on iOS could not be signed out.')).toBeDefined();
        expect(screen.getByRole('dialog', { name: 'Sign out Safari on iOS?' })).toBeDefined();
    });

    it('says when this is the only session, without offering to sign out the others', async () => {
        const engine = createSecurityEngine({
            seed: { sessions: [session('session-current', OWNER_ID, MAC_FIREFOX, '2026-09-20T09:59:00Z', true)] },
        });
        renderWithProviders({ path: '/security/sessions', engineApi: engine.client });
        expect(await screen.findByText("You're signed in only on this device.")).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Sign out other sessions' })).toBeNull();
    });

    it('shows an error with retry when the list fails', async () => {
        const engine = sessionsEngine();
        const listSessions = vi
            .spyOn(engine.client.me, 'listSessions')
            .mockImplementation(() => problemResponse('internal-error'));
        const { user } = renderWithProviders({ path: '/security/sessions', engineApi: engine.client });
        const retry = await within(await waitFor(() => list())).findByRole(
            'button',
            { name: 'Try again' },
            { timeout: 10_000 },
        );
        listSessions.mockRestore();
        await user.click(retry);
        expect(await screen.findByText('Firefox on macOS')).toBeDefined();
    });

    it('reads in Czech', async () => {
        renderWithProviders({ path: '/security/sessions', engineApi: sessionsEngine().client, locale: 'cs' });
        expect(await screen.findByRole('heading', { level: 1, name: 'Relace' })).toBeDefined();
        expect(await screen.findByText('Safari v systému iOS')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Odhlásit ostatní relace' })).toBeDefined();
    });
});
