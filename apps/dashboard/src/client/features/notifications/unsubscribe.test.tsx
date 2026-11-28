import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { notificationRoutes } from '../../../shared/api/notification-routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { renderApp } from '../../testing/render-app';
import { ok, problem } from '../../testing/scripted-api';

const TOKEN = `u1.${'a'.repeat(26)}.${'b'.repeat(26)}.agent-waiting~task-failed.${'c'.repeat(43)}`;

describe('unsubscribe page', () => {
    it('changes nothing on opening, and stops the emails only on the button, signed out', async () => {
        const app = renderApp({
            path: `/unsubscribe#${TOKEN}`,
            script: (api) => api.on(notificationRoutes.unsubscribe, ok(undefined)),
        });
        expect(await screen.findByRole('heading', { name: 'Stop these emails?', level: 1 })).toBeTruthy();
        // The token is out of the address bar before anything renders.
        expect(app.history.location.hash).toBe('');
        expect(app.api.callsTo(notificationRoutes.unsubscribe)).toEqual([]);
        await expectNoAxeViolations(app.container);
        await app.user.click(screen.getByRole('button', { name: 'Stop these emails' }));
        expect(await screen.findByRole('heading', { name: 'Emails stopped' })).toBeTruthy();
        expect(screen.getByText("You won't get these emails any more. You still see them in the app.")).toBeTruthy();
        expect(app.api.callsTo(notificationRoutes.unsubscribe)).toEqual([{ query: { token: TOKEN } }]);
        expect(screen.getByRole('link', { name: 'Open notification settings' }).getAttribute('href')).toBe(
            '/account#notifications',
        );
    });

    it('says calmly when the server does not accept the link', async () => {
        const app = renderApp({
            path: `/unsubscribe#${TOKEN}`,
            script: (api) => api.on(notificationRoutes.unsubscribe, problem(400, 'invalid-token')),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Stop these emails' }));
        expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Open notification settings' })).toBeTruthy();
    });

    it('does not post what cannot be a token, or nothing at all', async () => {
        for (const path of ['/unsubscribe#not a token', '/unsubscribe']) {
            const app = renderApp({ path });
            expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeTruthy();
            expect(screen.queryByRole('button', { name: 'Stop these emails' })).toBeNull();
            expect(app.api.callsTo(notificationRoutes.unsubscribe)).toEqual([]);
            app.unmount();
        }
    });

    it('keeps the question when the request did not get through', async () => {
        const app = renderApp({
            path: `/unsubscribe#${TOKEN}`,
            script: (api) => api.on(notificationRoutes.unsubscribe, { kind: 'network-error' }),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Stop these emails' }));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Stop these emails' })).toBeTruthy();
    });
});
