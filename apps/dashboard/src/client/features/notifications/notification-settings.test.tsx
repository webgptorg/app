import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { notificationRoutes } from '../../../shared/api/notification-routes';
import type { NotificationPreferenceView } from '../../../shared/api/notification-routes';
import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { NOTIFICATION_PERMISSIONS, notificationPreference, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';

const PREFERENCES: NotificationPreferenceView[] = [
    // Out of order on purpose: the page lists kinds in the registry's order.
    notificationPreference('agent-waiting', 'email'),
    notificationPreference('project-status', 'in-app', 'email'),
    notificationPreference('update-waiting', 'in-app'),
    notificationPreference('join-request', 'email'),
    notificationPreference('people-change', 'in-app'),
    notificationPreference('task-failed', 'email'),
    notificationPreference('tool-sign-in', 'off', 'email'),
];

function accountScript(api: ScriptedApi) {
    api.on(apiRoutes.listPasskeys, ok({ passkeys: [] }));
    api.on(apiRoutes.listSessions, ok({ sessions: [] }));
    api.on(notificationRoutes.listNotifications, ok({ notifications: [], otherOrgsWithUnseen: [] }));
    api.on(notificationRoutes.listNotificationPreferences, ok({ preferences: PREFERENCES }));
}

function settings() {
    return within(screen.getByRole('region', { name: 'Notification settings' }));
}

describe('notification settings', () => {
    it('lists every kind in order with its choice and the role default marked', async () => {
        const app = renderApp({
            path: '/account#notifications',
            session: session({ permissions: [...NOTIFICATION_PERMISSIONS] }),
            script: accountScript,
        });
        const offline = await screen.findByRole('combobox', { name: 'Project offline and back online' });
        expect(offline.textContent).toBe('In the app');
        expect(
            settings()
                .getAllByRole('combobox')
                .map((box) => box.getAttribute('aria-labelledby')),
        ).toHaveLength(7);
        const labels = settings()
            .getAllByRole('listitem')
            .map((item) => item.querySelector('span')?.textContent);
        expect(labels.slice(0, 2)).toEqual(['Project offline and back online', 'Update waiting']);
        expect(
            screen.getByText(
                "Emails about signing in, recovery and invitations always arrive and can't be turned off.",
            ),
        ).toBeTruthy();
        await app.user.click(offline);
        expect(screen.getByRole('option', { name: 'In the app and by email (default)' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Off' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('saves a change and says so', async () => {
        const app = renderApp({
            path: '/account',
            session: session({ permissions: [...NOTIFICATION_PERMISSIONS] }),
            script: (api) => {
                accountScript(api);
                api.on(notificationRoutes.setNotificationPreference, (input) =>
                    ok({
                        preferences: PREFERENCES.map((preference) =>
                            preference.kind === input.params.kind
                                ? { ...preference, channel: input.body.channel }
                                : preference,
                        ),
                    }),
                );
            },
        });
        await app.user.click(await screen.findByRole('combobox', { name: 'Update waiting' }));
        await app.user.click(screen.getByRole('option', { name: 'Off' }));
        expect(await screen.findByText('"Update waiting" saved.')).toBeTruthy();
        expect(app.api.callsTo(notificationRoutes.setNotificationPreference)).toEqual([
            { params: { kind: 'update-waiting' }, body: { channel: 'off' } },
        ]);
        expect(screen.getByRole('combobox', { name: 'Update waiting' }).textContent).toBe('Off');
    });

    it('says what could not be saved', async () => {
        const app = renderApp({
            path: '/account',
            session: session({ permissions: [...NOTIFICATION_PERMISSIONS] }),
            script: (api) => {
                accountScript(api);
                api.on(notificationRoutes.setNotificationPreference, problem(500, 'internal'));
            },
        });
        await app.user.click(await screen.findByRole('combobox', { name: 'Update waiting' }));
        await app.user.click(screen.getByRole('option', { name: 'Off' }));
        expect(await screen.findByText('"Update waiting" could not be saved.')).toBeTruthy();
        expect(screen.getByRole('combobox', { name: 'Update waiting' }).textContent).toBe('In the app (default)');
    });

    it('is not there without the permission', async () => {
        const app = renderApp({ path: '/account', session: session(), script: accountScript });
        await screen.findByRole('heading', { name: 'Account', level: 1 });
        expect(screen.queryByRole('region', { name: 'Notification settings' })).toBeNull();
        expect(app.api.callsTo(notificationRoutes.listNotificationPreferences)).toEqual([]);
    });
});
