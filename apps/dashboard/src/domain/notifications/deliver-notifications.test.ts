import { describe, expect, it } from 'vitest';

import { createNotificationScenario, NOTIFICATION_START_MS as START } from '../../testing/test-notifications';
import {
    CLOSED_ROW_RETENTION_MS,
    DUE_WINDOW_MS,
    HOURLY_CAP_MS,
    RETRY_DELAY_MS,
    SEEN_ROW_LINGER_MS,
} from './deliver-notifications';

const MINUTE = 60_000;
const signal = new AbortController().signal;

async function setup() {
    const t = await createNotificationScenario();
    return { ...t, to: t.emailsTo };
}

describe('runNotificationDelivery', () => {
    it('emails only after the delay, only verified people, with dashboard-owned facts and an unsubscribe', async () => {
        const t = await setup();
        await t.notifications.notify('join-request', t.target, { kind: 'waiting', requests: 1 }, signal);
        expect(await t.deliver(START + 15 * MINUTE - 1)).toEqual({ emails: 0, failed: 0 });
        expect(await t.deliver(START + 15 * MINUTE)).toEqual({ emails: 2, failed: 0 });
        expect(t.to(t.unverified)).toEqual([]);
        expect(t.to(t.owner)).toEqual([
            {
                template: 'notifications',
                to: t.owner.email,
                locale: 'cs',
                place: { orgName: 'Acme', project: { label: 'Marketing site', hostname: 'm.engines.ptbk.test' } },
                items: [
                    {
                        kind: 'join-request',
                        variant: null,
                        count: 1,
                        openedAt: START,
                        updatedAt: START,
                        link: 'https://m.engines.ptbk.test/members',
                    },
                ],
                requesters: ['jana@example.test'],
                settingsLink: 'https://app.ptbk.test/account#notifications',
                unsubscribe: {
                    page: expect.stringMatching(/^https:\/\/app\.ptbk\.test\/unsubscribe#tok-\d$/) as unknown,
                    oneClick: expect.stringMatching(
                        /^https:\/\/app\.ptbk\.test\/email\/unsubscribe\?token=tok-\d$/,
                    ) as unknown,
                },
            },
        ]);
        expect(t.signed).toContainEqual({ userId: t.owner.userId, orgId: t.orgId, kinds: ['join-request'] });
        expect(await t.deliver(START + 60 * MINUTE)).toEqual({ emails: 0, failed: 0 });
    });

    it('sends nothing for a platform row seen in-app meanwhile, but still for an engine count', async () => {
        const t = await setup();
        await t.notifications.notify('join-request', t.target, { kind: 'waiting', requests: 1 }, signal);
        await t.notifications.syncAttention(
            t.target,
            [{ to: t.admin.userId, kind: 'agent-waiting', count: 1 }],
            signal,
        );
        const ids = t.store.rows.filter((row) => row.userId === t.admin.userId).map((row) => row.id);
        await t.store.markSeen(t.orgId, t.admin.userId, ids, START + MINUTE);
        await t.deliver(START + 15 * MINUTE);
        expect(t.to(t.admin).map((message) => message.items.map((item) => item.kind))).toEqual([['agent-waiting']]);
        expect(t.store.rows.find((row) => row.userId === t.admin.userId && row.kind === 'join-request')).toMatchObject({
            dueAt: null,
            emailedAt: null,
        });
    });

    it('merges what is due into one email per person and project, and caps it at one an hour', async () => {
        const t = await setup();
        await t.notifications.syncAttention(
            t.target,
            [
                { to: t.admin.userId, kind: 'agent-waiting', count: 2 },
                { to: t.admin.userId, kind: 'task-failed', count: 1 },
            ],
            signal,
        );
        await t.deliver(START + 15 * MINUTE);
        expect(t.to(t.admin).map((message) => message.items.length)).toEqual([2]);
        expect(t.signed).toEqual([{ userId: t.admin.userId, orgId: t.orgId, kinds: ['agent-waiting', 'task-failed'] }]);

        t.clock.set(START + 20 * MINUTE);
        await t.notifications.syncAttention(
            t.target,
            [{ to: t.admin.userId, kind: 'agent-waiting', count: 3 }],
            signal,
        );
        await t.deliver(START + 35 * MINUTE);
        expect(t.to(t.admin)).toHaveLength(1);
        // Held until the hour since the last email is up, not dropped.
        expect(t.store.rows.find((row) => row.closedAt === null && row.kind === 'agent-waiting')).toMatchObject({
            dueAt: START + 15 * MINUTE + HOURLY_CAP_MS,
        });
        await t.deliver(START + 15 * MINUTE + HOURLY_CAP_MS);
        expect(t.to(t.admin)).toHaveLength(2);
    });

    it('lets status emails through the cap, as today’s status emails always went', async () => {
        const t = await setup();
        await t.notifications.notify('project-status', t.target, { kind: 'offline', lastSeenAt: START }, signal);
        await t.deliver(START);
        t.clock.set(START + 10 * MINUTE);
        await t.notifications.notify('project-status', t.target, { kind: 'back-online' }, signal);
        await t.deliver(START + 10 * MINUTE);
        expect(t.to(t.admin).map((message) => message.items[0]?.variant)).toEqual(['offline', 'back-online']);
        expect(t.to(t.admin)[1]?.items[0]).toMatchObject({ openedAt: START, updatedAt: START + 10 * MINUTE });
    });

    it('checks again that the person is still one the kind reaches', async () => {
        const t = await setup();
        await t.notifications.notify('join-request', t.target, { kind: 'waiting', requests: 1 }, signal);
        await t.notifications.syncAttention(
            t.target,
            [{ to: t.member.userId, kind: 'agent-waiting', count: 1 }],
            signal,
        );
        // The admin's access is no longer approved: no longer a manager, so the join request is not theirs to see.
        t.directory.setPeople(t.orgId, [t.owner, { ...t.admin, projects: { [t.engineId]: 'waiting' } }, t.member]);
        await t.deliver(START + 15 * MINUTE);
        expect(t.to(t.admin)).toEqual([]);
        expect(t.to(t.owner)).toHaveLength(1);
        expect(t.to(t.member).map((message) => message.items[0]?.kind)).toEqual(['agent-waiting']);
    });

    it('reads recipients and preferences again when it sends', async () => {
        const t = await setup();
        await t.notifications.notify('project-status', t.target, { kind: 'offline', lastSeenAt: START }, signal);
        await t.store.setOverride(t.orgId, t.owner.userId, 'project-status', 'in-app');
        t.directory.setPeople(t.orgId, [t.owner, t.unverified]);
        await t.deliver(START);
        expect(t.outbox.sent).toEqual([]);
        expect(t.store.rows.every((row) => row.dueAt === null)).toBe(true);
    });

    it('sends nothing about a project no longer active, or no longer the organization’s', async () => {
        const t = await setup();
        await t.notifications.notify('project-status', t.target, { kind: 'offline', lastSeenAt: START }, signal);
        t.directory.setProject(t.orgId, t.engineId, { label: 'x', hostname: 'm.engines.ptbk.test', active: false });
        await t.deliver(START);
        expect(t.outbox.sent).toEqual([]);
    });

    it('tries a failed send again later inside the window, and logs counts only', async () => {
        const t = await setup();
        await t.notifications.notify('project-status', t.target, { kind: 'offline', lastSeenAt: START }, signal);
        const report = await t.deliver(START, { send: () => Promise.reject(new Error('provider refused')) });
        expect(report).toEqual({ emails: 0, failed: 2 });
        expect(t.logger.entries).toEqual([
            { level: 'warn', event: 'notifications.send-failed', fields: { failed: 2, sent: 0 } },
        ]);
        expect(t.store.rows.filter((row) => row.dueAt === START + RETRY_DELAY_MS)).toHaveLength(2);
        await t.deliver(START + RETRY_DELAY_MS);
        expect(t.outbox.sent).toHaveLength(2);
        // Something due longer ago than the window is not chased any more.
        await t.store.setOverride(t.orgId, t.admin.userId, 'update-waiting', 'email');
        await t.notifications.notify('update-waiting', t.target, { kind: 'waiting' }, signal);
        expect(await t.deliver(START + DUE_WINDOW_MS + 15 * MINUTE + 1)).toEqual({ emails: 0, failed: 0 });
    });

    it('closes seen notices after a day, untouched rows after their lifetime, and deletes closed rows after 30 days', async () => {
        const t = await setup();
        await t.notifications.notify('people-change', { orgId: t.orgId, engineId: null }, { kind: 'joined' }, signal);
        await t.notifications.notify('project-status', t.target, { kind: 'offline', lastSeenAt: START }, signal);
        const ownerRows = t.store.rows.filter((row) => row.userId === t.owner.userId).map((row) => row.id);
        await t.store.markSeen(t.orgId, t.owner.userId, ownerRows, START);
        await t.deliver(START + SEEN_ROW_LINGER_MS + 1);
        const owner = t.store.rows.filter((row) => row.userId === t.owner.userId);
        // The seen notice closed; the seen outage stays, since an outage closes when it ends.
        expect(owner.map((row) => [row.kind, row.closedAt !== null])).toEqual([
            ['people-change', true],
            ['project-status', false],
        ]);
        await t.deliver(START + 30 * 24 * 60 * MINUTE + 1);
        expect(t.store.rows.every((row) => row.closedAt !== null)).toBe(true);
        await t.deliver(START + 30 * 24 * 60 * MINUTE + 2 + CLOSED_ROW_RETENTION_MS);
        expect(t.store.rows).toEqual([]);
    });

    it('links only to the dashboard’s pages and the project’s own hostname, and to the dashboard when there is no project', async () => {
        const t = await setup();
        const org = { orgId: t.orgId, engineId: null };
        await t.notifications.notify('people-change', org, { kind: 'role', userId: t.owner.userId }, signal);
        await t.notifications.notify('people-change', t.target, { kind: 'added', userId: t.admin.userId }, signal);
        // Rows a kind would never make, written by hand: a project link with no project falls back to the dashboard.
        const base = t.store.rows[0];
        if (base === undefined) {
            throw new Error('no row');
        }
        await t.store.write([
            {
                op: 'insert',
                row: {
                    ...base,
                    closedAt: null,
                    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' as never,
                    kind: 'update-waiting',
                    variant: null,
                },
            },
            {
                op: 'insert',
                row: {
                    ...base,
                    closedAt: null,
                    id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' as never,
                    kind: 'project-status',
                    variant: 'online',
                    dueAt: START,
                },
            },
        ]);
        await t.store.setOverride(t.orgId, t.owner.userId, 'people-change', 'email');
        await t.store.setOverride(t.orgId, t.owner.userId, 'update-waiting', 'email');
        await t.store.setOverride(t.orgId, t.admin.userId, 'people-change', 'email');
        await t.store.write(
            t.store.rows
                .filter((row) => row.closedAt === null)
                .map((row) => ({
                    op: 'update' as const,
                    id: row.id,
                    fields: {
                        count: row.count,
                        variant: row.variant,
                        openedAt: row.openedAt,
                        updatedAt: row.updatedAt,
                        seenAt: null,
                        dueAt: START,
                    },
                })),
        );
        await t.deliver(START + 15 * MINUTE);
        expect(t.to(t.owner).flatMap((message) => message.items.map((item) => [item.kind, item.link]))).toEqual([
            ['project-status', 'https://app.ptbk.test/'],
            ['update-waiting', 'https://app.ptbk.test/'],
            ['people-change', 'https://app.ptbk.test/'],
        ]);
        expect(t.to(t.admin).flatMap((message) => message.items.map((item) => item.link))).toEqual([
            `https://app.ptbk.test/engines/${t.engineId}`,
        ]);
    });
});
