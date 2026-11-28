import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notificationRoutes } from '../../../shared/api/notification-routes';
import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { NOTIFICATION_PERMISSIONS, notificationPreference, notificationView, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok } from '../../testing/scripted-api';

// Paraglide resolves the first locale once per page load, so the Czech screens live in their own test file.
describe('notifications for a Czech browser', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shows the bell, its lines and the settings in Czech', async () => {
        const app = renderApp({
            path: '/account',
            session: session({ permissions: [...NOTIFICATION_PERMISSIONS] }),
            script: (api) => {
                api.on(apiRoutes.listPasskeys, ok({ passkeys: [] }));
                api.on(apiRoutes.listSessions, ok({ sessions: [] }));
                api.on(
                    notificationRoutes.listNotifications,
                    ok({
                        notifications: [
                            notificationView({ kind: 'agent-waiting', variant: null, count: 3 }),
                            notificationView({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaab', variant: 'back-online' }),
                        ],
                        otherOrgsWithUnseen: [],
                    }),
                );
                api.on(notificationRoutes.markNotificationsSeen, ok(undefined));
                api.on(
                    notificationRoutes.listNotificationPreferences,
                    ok({ preferences: [notificationPreference('update-waiting', 'in-app')] }),
                );
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Upozornění, 2 nová' }));
        const panel = within(screen.getByRole('dialog', { name: 'Upozornění' }));
        expect(panel.getByText('V projektu Sales bot na vás čekají 3 agenti')).toBeTruthy();
        expect(panel.getByText('Sales bot je znovu online')).toBeTruthy();
        expect(panel.getByRole('link', { name: 'Nastavení upozornění' })).toBeTruthy();
        const settings = within(await screen.findByRole('region', { name: 'Nastavení upozornění' }));
        expect((await settings.findByRole('combobox', { name: 'Čekající aktualizace' })).textContent).toBe(
            'V aplikaci (výchozí)',
        );
        await expectNoAxeViolations(app.container);
    });

    it('asks in Czech before stopping emails', async () => {
        renderApp({ path: `/unsubscribe#u1.${'a'.repeat(26)}.${'b'.repeat(26)}.task-failed.${'c'.repeat(43)}` });
        expect(await screen.findByRole('heading', { name: 'Přestat posílat tyto e-maily?', level: 1 })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Přestat posílat' })).toBeTruthy();
    });
});
