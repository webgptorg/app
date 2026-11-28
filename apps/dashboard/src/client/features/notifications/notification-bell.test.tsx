import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { notificationRoutes } from '../../../shared/api/notification-routes';
import type { NotificationView } from '../../../shared/api/notification-routes';
import type { SessionView } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import {
    ENGINE_DOMAIN,
    ENGINE_ID,
    NOTIFICATION_PERMISSIONS,
    NOW,
    notificationView,
    session,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';

const MARKETING_ID = 'mmmmmmmmmmmmmmmmmmmmmmmmmm';
const MARKETING = {
    engineId: MARKETING_ID as NonNullable<NotificationView['project']>['engineId'],
    label: 'Marketing site',
    hostname: `${MARKETING_ID}.${ENGINE_DOMAIN}` as NonNullable<NotificationView['project']>['hostname'],
};
const OTHER_ORG = 'cccccccccccccccccccccccccc';

const OFFLINE = notificationView({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaa2' });
const AGENTS = notificationView({
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaa3',
    kind: 'agent-waiting',
    variant: null,
    count: 2,
    project: MARKETING,
});
const TASKS = notificationView({
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaa4',
    kind: 'task-failed',
    variant: null,
    project: MARKETING,
});
const JOINED = notificationView({
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaa5',
    kind: 'people-change',
    variant: 'joined',
    count: 2,
    project: null,
    seen: true,
});
const REQUEST = notificationView({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaa6', kind: 'join-request', variant: null, seen: true });

function signedIn(overrides: Partial<SessionView> = {}): SessionView {
    return { ...session({ name: 'Acme', permissions: ['engine.read', ...NOTIFICATION_PERMISSIONS] }), ...overrides };
}

/** The list as the server keeps it: marking seen flips the rows it named, and the next read shows it. */
function scriptInbox(rows: readonly NotificationView[], otherOrgsWithUnseen: readonly string[] = []) {
    return (api: ScriptedApi) => {
        const seen = new Set<string>();
        api.on(notificationRoutes.listNotifications, () =>
            ok({
                notifications: rows.map((row) => ({ ...row, seen: row.seen || seen.has(row.id) })),
                otherOrgsWithUnseen: [...otherOrgsWithUnseen],
            }),
        );
        api.on(notificationRoutes.markNotificationsSeen, (input) => {
            for (const id of input.body.ids) seen.add(id);
            return ok(undefined);
        });
    };
}

function rowOf(line: string) {
    const item = screen.getByText(line).closest('li');
    if (item === null) throw new Error(`no row for ${line}`);
    return within(item);
}

const TIME = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(NOW - 78 * 60_000);

describe('notification bell', () => {
    it('shows a dot while something is unseen and lists the organization’s notifications', async () => {
        const app = renderApp({
            path: '/',
            session: signedIn(),
            script: scriptInbox([OFFLINE, AGENTS, JOINED, TASKS, REQUEST]),
        });
        const bell = await screen.findByRole('button', { name: 'Notifications, 3 new' });
        expect(bell.querySelector('span[aria-hidden="true"].rounded-pill')).not.toBeNull();
        await app.user.click(bell);
        const panel = within(screen.getByRole('dialog', { name: 'Notifications' }));
        const lines = panel.getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent);
        // One line per project for what its engine counts, in the place its first row had.
        expect(lines).toEqual([
            `Sales bot is offline since ${TIME}`,
            '3 things need you in Marketing site',
            '2 people joined Acme',
            expect.stringContaining('Sales bot'),
        ]);
        await expectNoAxeViolations(app.container);
    });

    it('opens the dashboard’s own pages in place and a project only at its registered hostname', async () => {
        const app = renderApp({
            path: '/',
            session: signedIn(),
            script: scriptInbox([OFFLINE, AGENTS, JOINED, REQUEST]),
        });
        await app.user.click(await screen.findByRole('button', { name: /^Notifications/ }));
        expect(
            rowOf(`Sales bot is offline since ${TIME}`).getByRole('link', { name: 'Open' }).getAttribute('href'),
        ).toBe(`/engines/${ENGINE_ID}`);
        expect(rowOf('2 people joined Acme').getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/people');
        const project = rowOf('2 agents are waiting for you in Marketing site').getByRole('link', { name: /^Open/ });
        expect(project.getAttribute('href')).toBe(`https://${MARKETING.hostname}/`);
        expect(project.getAttribute('target')).toBe('_blank');
        expect(project.getAttribute('rel')).toBe('noopener noreferrer');
        const request = screen.getAllByRole('link', { name: /^Open/ }).at(-1);
        expect(request?.getAttribute('href')).toBe(`https://${ENGINE_ID}.${ENGINE_DOMAIN}/members`);
        expect(screen.getByRole('link', { name: 'Notification settings' }).getAttribute('href')).toBe(
            '/account#notifications',
        );
    });

    it('marks what it showed as seen when opened, and the dot goes', async () => {
        const app = renderApp({ path: '/', session: signedIn(), script: scriptInbox([OFFLINE, AGENTS, JOINED]) });
        await app.user.click(await screen.findByRole('button', { name: 'Notifications, 2 new' }));
        expect(app.api.callsTo(notificationRoutes.markNotificationsSeen)).toEqual([
            { body: { ids: [OFFLINE.id, AGENTS.id, JOINED.id] } },
        ]);
        expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
        await waitFor(() => {
            expect(app.api.callsTo(notificationRoutes.listNotifications).length).toBeGreaterThanOrEqual(2);
        });
        // Closing and opening again with nothing unseen asks nothing more.
        await app.user.click(screen.getByRole('button', { name: 'Notifications' }));
        await app.user.click(screen.getByRole('button', { name: 'Notifications' }));
        expect(app.api.callsTo(notificationRoutes.markNotificationsSeen)).toHaveLength(1);
    });

    it('says so in one quiet line when nothing is open', async () => {
        const app = renderApp({ path: '/', session: signedIn(), script: scriptInbox([]) });
        await app.user.click(await screen.findByRole('button', { name: 'Notifications' }));
        expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
        expect(app.api.callsTo(notificationRoutes.markNotificationsSeen)).toEqual([]);
    });

    it('stays calm when the list cannot be loaded', async () => {
        const app = renderApp({
            path: '/',
            session: signedIn(),
            script: (api) => api.on(notificationRoutes.listNotifications, problem(500, 'internal')),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Notifications' }));
        expect(await screen.findByText('Notifications could not be loaded. They come back on their own.')).toBeTruthy();
    });

    it('is not there for someone who may not read notifications', async () => {
        const app = renderApp({ path: '/', session: session({ permissions: ['engine.read'] }) });
        await screen.findByRole('heading', { name: 'Projects' });
        expect(screen.queryByRole('button', { name: /^Notifications/ })).toBeNull();
        expect(app.api.callsTo(notificationRoutes.listNotifications)).toEqual([]);
    });

    it('marks other organizations with something unseen in the org switcher', async () => {
        const base = signedIn();
        const app = renderApp({
            path: '/',
            session: {
                ...base,
                memberships: [
                    { orgId: base.activeOrg.id, kind: 'personal', name: 'Acme', role: 'owner' },
                    { orgId: OTHER_ORG, kind: 'team', name: 'Beta', role: 'member' },
                ],
            },
            script: scriptInbox([], [OTHER_ORG]),
        });
        const trigger = await screen.findByRole('button', { name: 'Organization: Acme' });
        await waitFor(() => {
            expect(trigger.getAttribute('aria-describedby')).not.toBeNull();
        });
        expect(document.getElementById(trigger.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
            'Another organization has new notifications',
        );
        await app.user.click(trigger);
        expect(screen.getByRole('menuitemradio', { name: 'Beta, new notifications' })).toBeTruthy();
        expect(screen.getByRole('menuitemradio', { name: 'Acme' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });
});
