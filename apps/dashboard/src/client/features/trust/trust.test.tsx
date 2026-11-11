import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';

describe('trust page', () => {
    it('shows anyone signed out the promise, the path their data takes, and what we can and cannot do', async () => {
        const app = renderApp({ path: '/trust' });
        expect(await screen.findByRole('heading', { name: 'How Promptbook protects you', level: 1 })).toBeTruthy();
        expect(
            screen.getByText(/stay on your own server\. We connect you to them, but we can't read them\./),
        ).toBeTruthy();

        const path = screen.getByRole('region', { name: 'How you reach your engine' });
        expect(
            within(path)
                .getAllByRole('heading', { level: 3 })
                .map((heading) => heading.textContent),
        ).toEqual(['Your browser', 'Our relay', 'Your engine', 'This dashboard']);
        expect(within(path).getByText(/Passes the sealed traffic on to your engine\. It can't open it\./)).toBeTruthy();
        expect(within(path).getByText(/Holds your data and its keys\./)).toBeTruthy();
        expect(within(path).getByText(/Never what is inside them\./)).toBeTruthy();

        const cannot = screen.getByRole('region', { name: "What we can't do" });
        expect(
            within(cannot)
                .getAllByRole('heading', { level: 3 })
                .map((heading) => heading.textContent),
        ).toEqual(['See your work', 'Open your connection', 'Change the app in secret', 'Let anyone in']);
        expect(within(cannot).getByText(/We never store them, not even encrypted\./)).toBeTruthy();
        expect(within(cannot).getByText(/only pass it on and hold none of its keys/)).toBeTruthy();
        expect(within(cannot).getByText(/public for at least a day/)).toBeTruthy();
        expect(within(cannot).getByText(/your Promptbook account grants nothing inside it/)).toBeTruthy();

        const can = screen.getByRole('region', { name: 'What we can do' });
        expect(within(can).getByText(/Never names or text\./)).toBeTruthy();
        expect(within(can).getByText(/unless your engine's owner turns that off/)).toBeTruthy();
        expect(within(can).getByText(/your agents keep running and nothing is lost/)).toBeTruthy();

        const check = screen.getByRole('region', { name: 'Check it yourself' });
        expect(within(check).getByText(/enter nothing there and open your engine from this dashboard/)).toBeTruthy();
        const source = within(check).getByRole('link', { name: /^read its code/ });
        expect(source.getAttribute('href')).toBe('https://github.com/webgptorg/promptbook');
        expect(source.getAttribute('rel')).toBe('noopener noreferrer');

        expect(app.container.querySelectorAll('svg:not([aria-hidden="true"])')).toHaveLength(0);
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
        renderApp({ path: '/continue' });
        expect(await screen.findByRole('button', { name: 'EN, Language: English' })).toBeTruthy();
        const footer = screen.getByRole('navigation', { name: 'About Promptbook' });
        const links = within(footer).getAllByRole('link');
        expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
            ['How Promptbook protects you', '/trust'],
            ['Report abuse', '/abuse'],
        ]);
    });

    it('tells someone new what Promptbook is before asking for an email', async () => {
        renderApp({ path: '/continue' });
        expect(
            await screen.findByText(
                'Run AI agents on your own server and use them from anywhere. Your data stays with you.',
            ),
        ).toBeTruthy();
    });
});
