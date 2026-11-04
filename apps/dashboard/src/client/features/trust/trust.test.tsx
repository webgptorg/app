import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';

describe('trust page', () => {
    it('explains, to anyone signed out, what we keep and what we cannot see', async () => {
        const app = renderApp({ path: '/trust' });
        expect(await screen.findByRole('heading', { name: 'How Promptbook protects you', level: 1 })).toBeTruthy();
        expect(screen.getByText(/It never stores engine content, not even encrypted\./)).toBeTruthy();
        expect(screen.getByText(/the relays only pass it on, never decrypt it/)).toBeTruthy();
        expect(screen.getByText(/It grants nothing inside the engine/)).toBeTruthy();
        expect(screen.getByText(/Only the engine can make you its owner\./)).toBeTruthy();
        expect(screen.getByText(/card details never reach Promptbook/)).toBeTruthy();
        const fingerprint = screen.getByRole('heading', { name: 'Checking it is your engine' }).closest('section');
        expect(fingerprint?.textContent).toMatch(/enter nothing there and open your engine from this dashboard/);
        expect(app.api.callsTo(apiRoutes.listEngines)).toEqual([]);
        await expectNoAxeViolations(app.container);
    });

    it('stays the same page for someone signed in', async () => {
        renderApp({ path: '/trust', session: session() });
        expect(await screen.findByRole('heading', { name: 'How Promptbook protects you', level: 1 })).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Your engines' })).toBeNull();
    });

    it('does not link to itself from its footer', async () => {
        renderApp({ path: '/trust' });
        const footer = await screen.findByRole('navigation', { name: 'About Promptbook' });
        expect(
            within(footer)
                .getAllByRole('link')
                .map((link) => link.getAttribute('href')),
        ).toEqual(['/abuse']);
    });
});

describe('signed-out frame', () => {
    it('shows the language and links only to pages that exist', async () => {
        renderApp({ path: '/signin' });
        expect(await screen.findByRole('button', { name: 'EN, Language: English' })).toBeTruthy();
        const footer = screen.getByRole('navigation', { name: 'About Promptbook' });
        const links = within(footer).getAllByRole('link');
        expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
            ['How Promptbook protects you', '/trust'],
            ['Report abuse', '/abuse'],
        ]);
    });

    it('tells someone new what Promptbook is before asking for an email', async () => {
        renderApp({ path: '/signup' });
        expect(
            await screen.findByText(
                'Run AI agents on your own server and use them from anywhere. Your data stays with you.',
            ),
        ).toBeTruthy();
    });
});
