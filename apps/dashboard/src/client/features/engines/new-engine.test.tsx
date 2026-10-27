import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { INSTALL_GUIDE_URL, LINK_CODE as CODE, linkCodeView as linkCode, NOW, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok, problem } from '../../testing/scripted-api';

const OWNER = session({ permissions: ['org.read', 'billing.read', 'billing.manage', 'engine.link', 'engine.read'] });
const TAB_NAMES = ['Linux server with Docker', 'Docker Compose', 'Already running Promptbook'];

describe('new engine page', () => {
    it('sends a signed-out visitor to sign in first', async () => {
        const app = renderApp({ path: '/engines/new' });
        expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/signin');
    });

    it('is reachable from the empty engine list', async () => {
        const app = renderApp({ path: '/', session: OWNER });
        await app.user.click(await screen.findByRole('link', { name: 'Link an engine' }));
        expect(await screen.findByRole('heading', { name: 'Link an engine', level: 1 })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/engines/new');
    });

    it('shows the install command once, with a copy button and the time left', async () => {
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => api.on(apiRoutes.createLinkCode, ok(linkCode())),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Create link code' }));
        expect(await screen.findByText(CODE, { exact: false })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Copy install command' })).toBeTruthy();
        expect(screen.getByText('Expires in 30:00')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Create link code' })).toBeNull();
        expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(1);
        await expectNoAxeViolations(app.container);
    });

    it('offers the install paths as tabs in the configured order, the first selected', async () => {
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => api.on(apiRoutes.createLinkCode, ok(linkCode())),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Create link code' }));
        const list = await screen.findByRole('tablist', { name: 'How to install' });
        const tabs = within(list).getAllByRole('tab');
        expect(tabs.map((tab) => tab.textContent)).toEqual(TAB_NAMES);
        expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
        const panel = screen.getByRole('tabpanel', { name: 'Linux server with Docker' });
        expect(within(panel).getByText(`bun run dev:link ${CODE}`)).toBeTruthy();
        expect(within(panel).getByText(/It needs outbound HTTPS \(port 443\) and nothing inbound\./)).toBeTruthy();
        expect(
            within(panel)
                .getByRole('link', { name: /^Requirements and proxies/ })
                .getAttribute('href'),
        ).toBe(`${INSTALL_GUIDE_URL}#1-the-installer-recommended`);
        expect(within(panel).queryByText(/Moving from an existing Promptbook server/)).toBeNull();

        await app.user.click(within(list).getByRole('tab', { name: 'Already running Promptbook' }));
        const connect = screen.getByRole('tabpanel', { name: 'Already running Promptbook' });
        expect(within(connect).getByText(`promptbook-engine connect --link ${CODE}`)).toBeTruthy();
        expect(within(connect).getByText(/Moving from an existing Promptbook server\?/)).toBeTruthy();
        expect(
            within(connect)
                .getByRole('link', { name: /^Moving an existing deployment/ })
                .getAttribute('href'),
        ).toBe(`${INSTALL_GUIDE_URL}#moving-an-existing-deployment`);
        expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(1);
        await expectNoAxeViolations(app.container);
    });

    it('switches tabs with the keyboard and keeps a multi-line command intact', async () => {
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => api.on(apiRoutes.createLinkCode, ok(linkCode())),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Create link code' }));
        const first = await screen.findByRole('tab', { name: 'Linux server with Docker' });
        first.focus();
        await app.user.keyboard('{ArrowRight}');
        const compose = screen.getByRole('tab', { name: 'Docker Compose' });
        expect(document.activeElement).toBe(compose);
        expect(compose.getAttribute('aria-selected')).toBe('true');
        const code = screen.getByRole('tabpanel', { name: 'Docker Compose' }).querySelector('pre code');
        expect(code?.textContent).toBe(linkCode().installCommands[1]?.command);
        expect(code?.textContent).toContain('\n');
        await app.user.keyboard('{End}');
        expect(screen.getByRole('tab', { name: 'Already running Promptbook' }).getAttribute('aria-selected')).toBe(
            'true',
        );
        await app.user.keyboard('{Home}');
        expect(first.getAttribute('aria-selected')).toBe('true');
        await app.user.keyboard('{ArrowLeft}');
        expect(screen.getByRole('tab', { name: 'Already running Promptbook' }).getAttribute('aria-selected')).toBe(
            'true',
        );
    });

    it('copies the command of the selected tab', async () => {
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => api.on(apiRoutes.createLinkCode, ok(linkCode())),
        });
        // After renderApp: user-event installs its own clipboard stub in setup().
        const writeText = vi.fn(() => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        try {
            await app.user.click(await screen.findByRole('button', { name: 'Create link code' }));
            for (const [index, name] of TAB_NAMES.entries()) {
                await app.user.click(await screen.findByRole('tab', { name }));
                await app.user.click(
                    within(screen.getByRole('tabpanel', { name })).getByRole('button', {
                        name: 'Copy install command',
                    }),
                );
                expect(writeText).toHaveBeenLastCalledWith(linkCode().installCommands[index]?.command);
            }
            expect(writeText).toHaveBeenCalledTimes(3);
        } finally {
            Reflect.deleteProperty(navigator, 'clipboard');
        }
    });

    it('shows a single configured path without anything the other tabs add', async () => {
        const [installer] = linkCode().installCommands;
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) =>
                api.on(apiRoutes.createLinkCode, ok(linkCode({ installCommands: installer ? [installer] : [] }))),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Create link code' }));
        expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual([TAB_NAMES[0]]);
        expect(screen.queryByText(/Put the Compose file/)).toBeNull();
        expect(app.container.textContent).not.toMatch(/engines_new_/);
    });

    it.each([
        ['not-entitled', 'Your plan does not include engines'],
        ['engine-limit', "Your plan's engine limit is reached"],
    ])('shows the upgrade path for %s instead of an install command', async (code, title) => {
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => api.on(apiRoutes.createLinkCode, problem(403, code)),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Create link code' }));
        expect(await screen.findByRole('link', { name: 'Go to billing' })).toBeTruthy();
        expect(screen.getAllByText(title).length).toBeGreaterThan(0);
        expect(screen.queryByText(CODE, { exact: false })).toBeNull();
        await expectNoAxeViolations(app.container);
    });

    it('reports the link-code rate limit without an upgrade path', async () => {
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => api.on(apiRoutes.createLinkCode, problem(429, 'rate-limited')),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Create link code' }));
        expect(await screen.findByText('Too many attempts. Wait a minute and try again.')).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Go to billing' })).toBeNull();
    });

    it('offers a new code once the shown one has expired', async () => {
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => api.once(apiRoutes.createLinkCode, ok(linkCode({ expiresAt: NOW })), ok(linkCode())),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Create link code' }));
        expect(await screen.findByText('The link code expired')).toBeTruthy();
        expect(screen.queryByText(CODE, { exact: false })).toBeNull();
        await app.user.click(screen.getByRole('button', { name: 'Create a new link code' }));
        await waitFor(() => {
            expect(screen.getByText('Expires in 30:00')).toBeTruthy();
        });
        expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(2);
    });

    it('explains that only owners link engines', async () => {
        renderApp({ path: '/engines/new', session: session({ permissions: ['org.read'] }) });
        expect(await screen.findByText('Only owners of this organization can link engines.')).toBeTruthy();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create link code' }).disabled).toBe(true);
    });
});
