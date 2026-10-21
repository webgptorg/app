import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes, type LinkCodeView } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { NOW, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok, problem } from '../../testing/scripted-api';

const OWNER = session({ permissions: ['org.read', 'billing.read', 'billing.manage', 'engine.link'] });
const CODE = 'abcdefghijklmnopqrstuvwxya';

function linkCode(overrides: Partial<LinkCodeView> = {}): LinkCodeView {
    return {
        linkCode: CODE as LinkCodeView['linkCode'],
        installCommand: `bun run dev:link ${CODE}`,
        expiresAt: NOW + 30 * 60_000,
        ...overrides,
    };
}

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
