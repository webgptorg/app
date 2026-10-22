import { THEME_STORAGE_KEY } from '@ptbk/ui';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok, problem } from '../../testing/scripted-api';

function nav() {
    return within(screen.getByRole('navigation', { name: 'Main' }));
}

describe('signed-in shell', () => {
    it('shows the org, navigation by capability and the home page', async () => {
        const app = renderApp({ path: '/', session: session({ name: 'Acme' }) });
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
        expect(screen.getByText('Acme')).toBeTruthy();
        expect(nav().getByRole('link', { name: 'Engines' }).getAttribute('aria-current')).toBe('page');
        expect(nav().getByRole('link', { name: 'Account' })).toBeTruthy();
        expect(nav().queryByRole('link', { name: 'Admin' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Skip to content' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('names a personal org and hides what the role does not allow', async () => {
        renderApp({ path: '/', session: session({ permissions: [] }) });
        expect(await screen.findByRole('button', { name: 'Organization: Personal' })).toBeTruthy();
        expect(nav().queryByRole('link', { name: 'Engines' })).toBeNull();
        expect(nav().getByRole('link', { name: 'Account' })).toBeTruthy();
    });

    it('lists the memberships in the org switcher and moves the session to another organization', async () => {
        const acme = session({ name: 'Acme' });
        const both = {
            ...acme,
            memberships: [
                ...acme.memberships.map((membership) => ({ ...membership, name: 'Acme' })),
                { orgId: 'cccccccccccccccccccccccccc', kind: 'team' as const, name: 'Beta', role: 'owner' },
            ],
        };
        const beta = {
            ...both,
            activeOrg: { ...both.activeOrg, id: 'cccccccccccccccccccccccccc', kind: 'team' as const, name: 'Beta' },
        };
        const app = renderApp({
            path: '/engines',
            session: both,
            script: (api) => api.on(apiRoutes.setActiveOrg, ok(beta)),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Organization: Acme' }));
        expect(screen.getByRole('menuitemradio', { name: 'Acme' }).getAttribute('aria-checked')).toBe('true');
        await app.user.click(screen.getByRole('menuitemradio', { name: 'Beta' }));
        expect(await screen.findByRole('button', { name: 'Organization: Beta' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.setActiveOrg)).toEqual([{ body: { orgId: 'cccccccccccccccccccccccccc' } }]);
        expect(app.history.location.pathname).toBe('/engines');
        // The engine list of the new organization is fetched afresh, never served from the old one's cache.
        await waitFor(() => {
            expect(app.api.callsTo(apiRoutes.listEngines).length).toBeGreaterThanOrEqual(2);
        });
    });

    it('does not switch to the organization that is already active', async () => {
        const app = renderApp({ path: '/engines', session: session({ name: 'Acme' }) });
        await app.user.click(await screen.findByRole('button', { name: 'Organization: Acme' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'Personal' }));
        expect(app.api.callsTo(apiRoutes.setActiveOrg)).toHaveLength(0);
    });

    it('marks a non-production environment', async () => {
        renderApp({
            path: '/',
            session: session(),
            script: (api) => api.on(apiRoutes.getEnvironment, ok({ environment: 'staging' as const })),
        });
        expect(await screen.findByText('Environment: staging')).toBeTruthy();
    });

    it('signs out from the user menu', async () => {
        const app = renderApp({ path: '/', session: session(), script: (api) => api.on(apiRoutes.signout, ok({})) });
        await app.user.click(await screen.findByRole('button', { name: 'Account menu for ada@example.test' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
        expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/signin');
    });

    it('treats an already ended session as signed out', async () => {
        const app = renderApp({
            path: '/',
            session: session(),
            script: (api) => api.on(apiRoutes.signout, problem(401, 'unauthorized')),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Account menu for ada@example.test' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
        expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    });

    it('stays signed in and says so when signing out fails', async () => {
        const app = renderApp({
            path: '/',
            session: session(),
            script: (api) => api.on(apiRoutes.signout, problem(500, 'internal')),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Account menu for ada@example.test' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
        expect(await screen.findByText('Signing out did not work. Try again.')).toBeTruthy();
        expect(app.history.location.pathname).toBe('/engines');
    });

    it('switches language and theme from the user menu', async () => {
        const app = renderApp({ path: '/', session: session() });
        await app.user.click(await screen.findByRole('button', { name: 'Account menu for ada@example.test' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(app.storage.getItem(THEME_STORAGE_KEY)).toBe('dark');

        await app.user.click(screen.getByRole('button', { name: 'Account menu for ada@example.test' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'Čeština' }));
        expect(await screen.findByRole('heading', { name: 'Vaše enginy' })).toBeTruthy();
        expect(document.documentElement.lang).toBe('cs');
        expect(document.cookie).toContain('ptbk_locale=cs');

        await app.user.click(screen.getByRole('button', { name: 'Nabídka účtu ada@example.test' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'Podle systému' }));
        await app.user.click(screen.getByRole('button', { name: 'Nabídka účtu ada@example.test' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'English' }));
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
        expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('switches language and theme while signed out', async () => {
        const app = renderApp({ path: '/signin' });
        await app.user.click(await screen.findByRole('button', { name: 'Language and theme' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'Light' }));
        expect(app.storage.getItem(THEME_STORAGE_KEY)).toBe('light');
        await app.user.click(screen.getByRole('button', { name: 'Language and theme' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'Čeština' }));
        expect(await screen.findByRole('heading', { name: 'Přihlášení' })).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Jazyk a vzhled' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'English' }));
        expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    });
});

describe('admin area', () => {
    it('is not found for anyone but a platform admin', async () => {
        renderApp({ path: '/admin', session: session() });
        expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    });

    it('shows its navigation entry and empty shell to a platform admin', async () => {
        const app = renderApp({ path: '/admin', session: session({ platformRole: 'admin' }) });
        expect(await screen.findByRole('heading', { name: 'Platform admin' })).toBeTruthy();
        expect(nav().getByRole('link', { name: 'Admin' }).getAttribute('aria-current')).toBe('page');
        await expectNoAxeViolations(app.container);
    });
});

describe('route states', () => {
    it('shows an unknown URL as not found, with a way back', async () => {
        const app = renderApp({ path: '/nowhere/at/all', session: session() });
        expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
        await app.user.click(screen.getByRole('link', { name: 'Back to the start' }));
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
    });

    it('shows an error with a retry when the session cannot be checked', async () => {
        const app = renderApp({ path: '/', script: (api) => api.on(apiRoutes.getSession, { kind: 'network-error' }) });
        expect(await screen.findByText(/could not be reached/, {}, { timeout: 5000 })).toBeTruthy();
        app.api.on(apiRoutes.getSession, ok(session()));
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
    });

    it('explains other failures generically', async () => {
        renderApp({ path: '/', script: (api) => api.on(apiRoutes.getSession, problem(400, 'invalid-request')) });
        expect(await screen.findByText('The page could not be loaded. Try again in a moment.')).toBeTruthy();
    });
});

describe('theme', () => {
    it('follows the system while set to system', async () => {
        const { setMedia } = await import('@ptbk/ui');
        renderApp({ path: '/signin' });
        await screen.findByRole('heading', { name: 'Sign in' });
        setMedia('(prefers-color-scheme: dark)', true);
        await waitFor(() => {
            expect(document.documentElement.classList.contains('dark')).toBe(true);
        });
        setMedia('(prefers-color-scheme: dark)', false);
        await waitFor(() => {
            expect(document.documentElement.classList.contains('dark')).toBe(false);
        });
    });
});
