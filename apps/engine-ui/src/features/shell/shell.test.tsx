import { KNOWN_CAPABILITIES, SIGN_IN_PATH, SIGN_OUT_PATH } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { deriveEngineFingerprint } from '@ptbk/protocol';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FEATURES } from '../../app/features';
import { defineFeature } from '../../app/registry/feature';
import type { FeatureDefinition } from '../../app/registry/feature';
import { expectNoAxeViolations } from '../../testing/axe';
import { createFakeMatchMedia } from '../../testing/fake-match-media';
import { REFUSING_STORAGE } from '../../testing/memory-storage';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createTestEngineApi } from '../../testing/test-engine-api';
import { auditFeature } from '../audit/audit-feature';
import { NARROW_QUERY } from './use-media-query';

const ALL_PERMISSIONS: readonly Permission[] = [
    'agents.read',
    'members.read',
    'security.read',
    'secrets.read',
    'audit.read',
];

/** The sidebar's links, in document order. */
async function sidebarLinks(): Promise<string[]> {
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    return within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent);
}

describe('app shell', () => {
    it('renders the sidebar groups and items in the order of docs/design/ui.md', async () => {
        const { container } = renderWithProviders({ path: '/settings' });

        const nav = await screen.findByRole('navigation', { name: 'Main' });
        expect(within(nav).queryAllByRole('heading')).toEqual([]);
        expect(
            within(nav)
                .getAllByRole('list')
                .map((list) => document.getElementById(list.getAttribute('aria-labelledby') ?? '')?.textContent),
        ).toEqual(['Work', 'Resources', 'Administration']);
        expect(await sidebarLinks()).toEqual([
            'Home',
            'Agents',
            'Runs',
            'Files',
            'Triggers',
            'Integrations',
            'Members',
            'Security',
            'Secrets',
            'Audit log',
            'Settings',
        ]);
        await expectNoAxeViolations(container);
    });

    it('names the browser tab after the page and the engine, and renames it on navigation', async () => {
        const { user } = renderWithProviders({ path: '/settings' });
        await waitFor(() => {
            expect(document.title).toBe('Settings · Test engine');
        });
        const nav = await screen.findByRole('navigation', { name: 'Main' });
        await user.click(within(nav).getByRole('link', { name: 'Members' }));
        await waitFor(() => {
            expect(document.title).toBe('Members · Test engine');
        });
        await user.click(within(nav).getByRole('link', { name: 'Home' }));
        await waitFor(() => {
            expect(document.title).toBe('Home · Test engine');
        });
    });

    it('shows only Home, Security and Settings to a member without permissions, and "no access" on guarded routes', async () => {
        renderWithProviders({ path: '/members', permissions: [] });

        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
        expect(await sidebarLinks()).toEqual(['Home', 'Security', 'Settings']);
    });

    it('shows every item with full permissions', async () => {
        renderWithProviders({ path: '/members', permissions: ALL_PERMISSIONS });

        expect(await screen.findByRole('heading', { level: 1, name: 'Members' })).toBeDefined();
        expect(await sidebarLinks()).toEqual([
            'Home',
            'Agents',
            'Members',
            'Security',
            'Secrets',
            'Audit log',
            'Settings',
        ]);
    });

    it('ignores permission strings it does not know', async () => {
        const engineApi = createTestEngineApi();
        const me = await engineApi.me.get(AbortSignal.timeout(1000));
        if (me.kind !== 'ok') throw new Error('the in-memory engine refused /me');
        const granted = ['agents.read', 'agents.teleport', 'future.everything'] as unknown as Permission[];
        renderWithProviders({
            path: '/settings',
            engineApi: {
                ...engineApi,
                me: {
                    ...engineApi.me,
                    get: () => Promise.resolve({ ...me, data: { ...me.data, permissions: granted } }),
                },
            },
        });

        expect(await sidebarLinks()).toEqual(['Home', 'Agents', 'Security', 'Settings']);
    });

    it('hides a capability-gated feature the engine does not advertise, and its route says so', async () => {
        const gatedAudit: FeatureDefinition = {
            ...auditFeature,
            requires: { capability: KNOWN_CAPABILITIES.runs, permission: 'audit.read' },
        };
        const features = FEATURES.map((feature) => (feature.id === 'audit' ? gatedAudit : feature));
        renderWithProviders({ path: '/audit', features, capabilities: [], permissions: ALL_PERMISSIONS });

        expect(await screen.findByRole('heading', { level: 1, name: 'Not available on this engine' })).toBeDefined();
        expect(await sidebarLinks()).not.toContain('Audit log');
    });

    it('says "no access" for an advertised capability without the permission', async () => {
        const gatedAudit: FeatureDefinition = {
            ...auditFeature,
            requires: { capability: KNOWN_CAPABILITIES.runs, permission: 'audit.read' },
        };
        const features = FEATURES.map((feature) => (feature.id === 'audit' ? gatedAudit : feature));
        renderWithProviders({
            path: '/audit',
            features,
            capabilities: [KNOWN_CAPABILITIES.runs],
            permissions: ['agents.read'],
        });

        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
        expect(await sidebarLinks()).not.toContain('Audit log');
    });

    it('keeps the collapsed sidebar across a reload', async () => {
        const first = renderWithProviders({ path: '/settings' });
        await first.user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
        expect(screen.getByRole('button', { name: 'Expand sidebar' }).getAttribute('aria-expanded')).toBe('false');
        first.unmount();

        renderWithProviders({ path: '/settings', storage: first.storage });
        expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeDefined();
        const nav = screen.getByRole('navigation', { name: 'Main' });
        expect(within(nav).getByRole('link', { name: 'Settings' })).toBeDefined();
    });

    it("shows a collapsed link's name beside it on keyboard focus and on hover, and hides it on Esc", async () => {
        const { user } = renderWithProviders({ path: '/settings' });
        await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
        const nav = screen.getByRole('navigation', { name: 'Main' });
        const label = nav.querySelector<HTMLElement>('[popover]');
        if (label === null) throw new Error('no collapsed label');
        expect(label.getAttribute('aria-hidden')).toBe('true');

        within(nav).getByRole('link', { name: 'Agents' }).focus();
        await waitFor(() => {
            expect(label.dataset['fakePopoverOpen'] === 'true').toBe(true);
        });
        expect(label.textContent).toBe('Agents');
        await user.keyboard('{Escape}');
        await waitFor(() => {
            expect(label.dataset['fakePopoverOpen'] === 'true').toBe(false);
        });

        await user.hover(within(nav).getByRole('link', { name: 'Runs' }));
        await waitFor(() => {
            expect(label.textContent).toBe('Runs');
        });
        await user.unhover(within(nav).getByRole('link', { name: 'Runs' }));
        await waitFor(() => {
            expect(label.dataset['fakePopoverOpen'] === 'true').toBe(false);
        });

        await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
        expect(nav.querySelector('[popover]')).toBeNull();
    });

    it('shows the live indicator with a text label while work is active, and nothing at zero', async () => {
        let active = 2;
        const runs = defineFeature({
            id: 'runs-live',
            requires: {},
            liveIndicator: { useActiveCount: () => active },
        });
        const { unmount } = renderWithProviders({ path: '/settings', features: [...FEATURES, runs] });
        expect(await screen.findByText('2 running now')).toBeDefined();
        unmount();

        active = 0;
        renderWithProviders({ path: '/settings', features: [...FEATURES, runs] });
        await screen.findByRole('navigation', { name: 'Main' });
        expect(screen.queryByText(/running now/)).toBeNull();
    });

    it('keeps theme and language across a reload', async () => {
        const first = renderWithProviders({ path: '/settings' });
        await first.user.click(await screen.findByRole('button', { name: /Owner/ }));
        await first.user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        await first.user.click(screen.getByRole('button', { name: /^EN, / }));
        await first.user.click(screen.getByRole('menuitemradio', { name: 'Čeština' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Nastavení' })).toBeDefined();
        first.unmount();
        document.documentElement.className = '';

        renderWithProviders({ path: '/settings', storage: first.storage });
        expect(await screen.findByRole('heading', { level: 1, name: 'Nastavení' })).toBeDefined();
        expect(document.documentElement.lang).toBe('cs');
        await waitFor(() => {
            expect(document.documentElement.classList.contains('dark')).toBe(true);
        });
    });

    it('signs out at the engine gateway, then leaves with a full-page navigation', async () => {
        const { user, fetch, location } = renderWithProviders({ path: '/settings' });
        await user.click(await screen.findByRole('button', { name: /Owner/ }));
        await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

        await waitFor(() => {
            expect(location.assign).toHaveBeenCalledWith(SIGN_IN_PATH);
        });
        expect(fetch).toHaveBeenCalledWith(SIGN_OUT_PATH, expect.objectContaining({ method: 'POST' }));
    });

    it('stays signed in and says so when the gateway cannot be reached', async () => {
        const { user, location } = renderWithProviders({
            path: '/settings',
            fetch: () => Promise.reject(new TypeError('offline')),
        });
        await user.click(await screen.findByRole('button', { name: /Owner/ }));
        await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

        expect(await screen.findByText('Could not sign out. Check your connection and try again.')).toBeDefined();
        expect(location.assign).not.toHaveBeenCalled();
    });

    it('opens the navigation as a drawer below 768 px and returns focus on close', async () => {
        const media = createFakeMatchMedia({ [NARROW_QUERY]: true });
        const { user, container } = renderWithProviders({ path: '/settings', media });

        const open = await screen.findByRole('button', { name: 'Open navigation' });
        expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
        await user.click(open);
        const drawer = await screen.findByRole('dialog', { name: 'Menu' });
        expect(within(drawer).getByRole('link', { name: 'Settings' })).toBeDefined();

        await user.keyboard('{Escape}');
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
        });
        expect(document.activeElement).toBe(open);
        await expectNoAxeViolations(container);

        act(() => {
            media.set(NARROW_QUERY, false);
        });
        expect(await screen.findByRole('navigation', { name: 'Main' })).toBeDefined();
    });

    it('shows the current engine with the dashboard links only when the engine is linked', async () => {
        const linked = createTestEngineApi({
            seed: {
                engine: {
                    name: 'Lab',
                    hostname: 'lab.engine.test',
                    dashboardUrl: 'https://app.ptbk.test',
                    mode: 'tunnel',
                },
            },
        });
        const { user, unmount } = renderWithProviders({ path: '/settings', engineApi: linked });
        await user.click(await screen.findByRole('button', { name: /Lab/ }));
        expect(screen.getByRole('menuitem', { name: 'All engines' }).getAttribute('href')).toBe(
            'https://app.ptbk.test/',
        );
        expect(screen.getByRole('menuitem', { name: 'Add engine' }).getAttribute('href')).toBe(
            'https://app.ptbk.test/engines/new',
        );
        unmount();

        const second = renderWithProviders({ path: '/settings' });
        await second.user.click(await screen.findByRole('button', { name: /Test engine/ }));
        expect(screen.getByRole('menuitemradio', { name: /Test engine/ })).toBeDefined();
        expect(screen.queryByRole('menuitem', { name: 'All engines' })).toBeNull();
        expect(screen.queryByRole('menuitem', { name: 'Add engine' })).toBeNull();
    });

    it('verifies the engine from the switcher: the fingerprint code, then the trust panel', async () => {
        const { user, router } = renderWithProviders({ path: '/settings', permissions: ALL_PERMISSIONS });
        const engine = await createTestEngineApi().engine.get(AbortSignal.timeout(1000));
        if (engine.kind !== 'ok' || engine.data.engineId === null) throw new Error('the test engine has no ID');
        const { formatted } = deriveEngineFingerprint(engine.data.engineId);

        expect(screen.queryByRole('link', { name: /Engine security/ })).toBeNull();
        await user.click(await screen.findByRole('button', { name: /Test engine/ }));
        const verify = screen.getByRole('menuitem', { name: /Verify this engine/ });
        expect(verify.textContent).toContain(`Engine fingerprint ${formatted}`);
        expect(document.activeElement).toBe(verify);
        await user.click(verify);
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/security');
        });
        expect(router.state.location.hash).toBe('trust');
    });

    it("offers the verify item to every member, as Security is everyone's page", async () => {
        const { user } = renderWithProviders({ path: '/settings', permissions: [] });
        await user.click(await screen.findByRole('button', { name: /Test engine/ }));
        expect(screen.getByRole('menuitemradio', { name: /Test engine/ })).toBeDefined();
        expect(screen.getByRole('menuitem', { name: /Verify this engine/ })).toBeDefined();
    });

    it('opens Settings and Security from the account menu without repeating the name and role', async () => {
        const { user, router } = renderWithProviders({ path: '/members', permissions: ALL_PERMISSIONS });
        await user.click(await screen.findByRole('button', { name: /Owner/ }));
        const menu = screen.getByRole('menu', { name: 'Account menu' });
        expect(within(menu).queryByText(/Owner/)).toBeNull();
        await user.click(within(menu).getByRole('menuitem', { name: 'Security' }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/security');
        });

        await user.click(screen.getByRole('button', { name: /Owner/ }));
        await user.click(screen.getByRole('menuitem', { name: 'Settings' }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/settings');
        });
    });

    it('names the member in the account menu when the sidebar shows icons only', async () => {
        const { user } = renderWithProviders({ path: '/settings', permissions: [] });
        await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
        await user.click(screen.getByRole('button', { name: 'Account menu: Owner' }));
        const menu = screen.getByRole('menu', { name: 'Account menu' });
        expect(within(menu).getByText('Owner')).toBeDefined();
        expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toBeDefined();
        expect(within(menu).getByRole('menuitem', { name: 'Security' })).toBeDefined();
    });

    it('keeps the live indicator readable when the sidebar shows icons only', async () => {
        const runs = defineFeature({ id: 'runs-live', requires: {}, liveIndicator: { useActiveCount: () => 1 } });
        const { user } = renderWithProviders({ path: '/settings', features: [...FEATURES, runs] });
        await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));

        const label = await screen.findByText('1 running now');
        expect(label.className).toBe('sr-only');
        expect(label.parentElement?.getAttribute('title')).toBe('1 running now');
    });

    it('works when the browser refuses storage', async () => {
        const { user } = renderWithProviders({ path: '/settings', storage: REFUSING_STORAGE });
        await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
        expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeDefined();
    });

    it('stays signed in when the gateway refuses the sign-out', async () => {
        const { user, location } = renderWithProviders({
            path: '/settings',
            fetch: () => Promise.resolve(new Response(null, { status: 500 })),
        });
        await user.click(await screen.findByRole('button', { name: /Owner/ }));
        await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

        expect(await screen.findByText('Could not sign out. Check your connection and try again.')).toBeDefined();
        expect(location.assign).not.toHaveBeenCalled();
    });

    it('keeps the trust mark in the narrow top bar only, and closes the drawer when the account menu navigates', async () => {
        const media = createFakeMatchMedia({ [NARROW_QUERY]: true });
        const { user, router } = renderWithProviders({ path: '/members', media });
        await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
        const drawer = await screen.findByRole('dialog', { name: 'Menu' });
        expect(within(drawer).queryByRole('button', { name: /Test engine/ })).toBeNull();

        await user.click(within(drawer).getByRole('button', { name: /Owner/ }));
        await user.click(screen.getByRole('menuitem', { name: 'Settings' }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/settings');
        });
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
        });
    });

    it('closes the navigation drawer once a link is followed', async () => {
        const media = createFakeMatchMedia({ [NARROW_QUERY]: true });
        const { user, router } = renderWithProviders({ path: '/settings', media });
        await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
        await user.click(
            within(await screen.findByRole('dialog', { name: 'Menu' })).getByRole('link', { name: 'Agents' }),
        );

        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/agents');
        });
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
        });
    });
});
