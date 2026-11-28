import { describe, expect, it } from 'vitest';

import { createNotificationScenario, NOTIFICATION_START_MS as START } from '../../testing/test-notifications';

const signal = new AbortController().signal;
const setup = createNotificationScenario;

describe('notify', () => {
    it('opens one row per person the audience names, with the channel their role defaults to', async () => {
        const t = await setup();
        await t.notifications.notify('project-status', t.target, { kind: 'offline', lastSeenAt: START - 1000 }, signal);
        // Viewers: the org's owner and admin, and the people of its team; never someone outside it.
        expect(
            t
                .open()
                .map((row) => row.userId)
                .sort(),
        ).toEqual([t.owner, t.admin, t.member, t.waiting, t.unverified].map((p) => p.userId).sort());
        // Owners and admins by email (the offline threshold already waited), members in-app only.
        expect(t.rowOf(t.owner.userId)).toMatchObject({
            variant: 'offline',
            count: 1,
            openedAt: START - 1000,
            dueAt: START,
        });
        expect(t.rowOf(t.member.userId)).toMatchObject({ dueAt: null });
    });

    it('merges repeats into one open row whose count goes up and which is due again', async () => {
        const t = await setup();
        await t.notifications.notify('join-request', t.target, { kind: 'waiting', requests: 1 }, signal);
        // Only the managers: who linked it, and the org admins with approved access.
        expect(
            t
                .open()
                .map((row) => row.userId)
                .sort(),
        ).toEqual([t.owner, t.admin, t.unverified].map((p) => p.userId).sort());
        expect(t.rowOf(t.owner.userId)).toMatchObject({ count: 1, dueAt: START + 15 * 60_000 });
        await t.store.markSeen(t.orgId, t.owner.userId, [t.rowOf(t.owner.userId)?.id ?? ('' as never)], START);
        t.clock.advance(60_000);
        await t.notifications.notify('join-request', t.target, { kind: 'waiting', requests: 2 }, signal);
        expect(t.open().filter((row) => row.userId === t.owner.userId)).toHaveLength(1);
        expect(t.rowOf(t.owner.userId)).toMatchObject({
            count: 3,
            openedAt: START,
            seenAt: null,
            dueAt: START + 60_000 + 15 * 60_000,
        });
        await t.notifications.notify('join-request', t.target, { kind: 'answered', requests: 1 }, signal);
        expect(t.rowOf(t.owner.userId)).toMatchObject({ count: 2, dueAt: START + 60_000 + 15 * 60_000 });
        await t.notifications.notify('join-request', t.target, { kind: 'answered', requests: 2 }, signal);
        expect(t.open()).toEqual([]);
    });

    it('starts a fresh row when a re-armed one was already emailed, so the closed one keeps when', async () => {
        const t = await setup();
        await t.notifications.notify('project-status', t.target, { kind: 'offline', lastSeenAt: START }, signal);
        const offline = t.rowOf(t.owner.userId);
        await t.store.markEmailed([offline?.id ?? ('' as never)], START);
        await t.notifications.notify('project-status', t.target, { kind: 'back-online' }, signal);
        const back = t.rowOf(t.owner.userId);
        expect(back).toMatchObject({ variant: 'back-online', openedAt: START, emailedAt: null, dueAt: START });
        expect(back?.id).not.toBe(offline?.id);
        expect(t.store.rows.find((row) => row.id === offline?.id)).toMatchObject({ emailedAt: START, closedAt: START });
        // A member never emailed about the outage just loses the row: good news only for whoever heard the bad.
        expect(t.rowOf(t.member.userId)).toBeUndefined();
        expect(await t.store.lastEmailedAt(t.orgId, t.owner.userId, t.engineId)).toBe(START);
    });

    it('lets a person who switched the kind off, or left, only lose a row', async () => {
        const t = await setup();
        await t.store.setOverride(t.orgId, t.admin.userId, 'update-waiting', 'off');
        await t.notifications.notify('update-waiting', t.target, { kind: 'waiting' }, signal);
        expect(t.rowOf(t.admin.userId)).toBeUndefined();
        // Members default to off for updates.
        expect(t.rowOf(t.member.userId)).toBeUndefined();
        expect(t.rowOf(t.owner.userId)).toMatchObject({ dueAt: null });
        await t.store.setOverride(t.orgId, t.owner.userId, 'update-waiting', 'email');
        t.directory.setPeople(t.orgId, [t.admin]);
        await t.notifications.notify('update-waiting', t.target, { kind: 'waiting' }, signal);
        expect(t.rowOf(t.owner.userId)).toBeUndefined();
        expect(t.open()).toEqual([]);
    });

    it('keeps a row an event does not change, and writes nothing for it', async () => {
        const t = await setup();
        await t.notifications.notify('update-waiting', t.target, { kind: 'done' }, signal);
        expect(t.store.rows).toEqual([]);
        await t.notifications.notify('update-waiting', t.target, { kind: 'waiting' }, signal);
        const before = structuredClone(t.store.rows);
        t.clock.advance(1000);
        await t.notifications.notify('update-waiting', t.target, { kind: 'waiting' }, signal);
        expect(t.store.rows).toEqual(before);
        await t.notifications.notify('update-waiting', t.target, { kind: 'done' }, signal);
        expect(t.open()).toEqual([]);
    });

    it('tells a person about themselves only, and organization-level changes to its managers', async () => {
        const t = await setup();
        const org = { orgId: t.orgId, engineId: null };
        await t.notifications.notify('people-change', org, { kind: 'role', userId: t.member.userId }, signal);
        expect(t.open().map((row) => [row.userId, row.variant, row.dueAt])).toEqual([
            [t.member.userId, 'role', START + 15 * 60_000],
        ]);
        await t.notifications.notify('people-change', org, { kind: 'joined' }, signal);
        await t.notifications.notify('people-change', org, { kind: 'joined' }, signal);
        expect(t.rowOf(t.owner.userId)).toMatchObject({ variant: 'joined', count: 2, dueAt: null, engineId: null });
        await t.notifications.notify('people-change', org, { kind: 'role', userId: t.owner.userId }, signal);
        // Different changes merged read as "3 changes": the variant goes.
        expect(t.rowOf(t.owner.userId)).toMatchObject({ variant: null, count: 3 });
    });

    it('writes nothing when nobody is named and nothing is open', async () => {
        const t = await setup();
        await t.notifications.notify(
            'people-change',
            { orgId: t.orgId, engineId: null },
            { kind: 'role', userId: 'nobodynobodynobodynobodyno' },
            signal,
        );
        expect(t.store.rows).toEqual([]);
    });

    it('fails without writing when the directory cannot be read', async () => {
        const t = await setup();
        t.directory.fail();
        await expect(t.notifications.notify('update-waiting', t.target, { kind: 'waiting' }, signal)).rejects.toThrow();
        expect(t.store.rows).toEqual([]);
    });
});

describe('syncAttention (ADR 0027, "Mapping counts to people")', () => {
    it('gives an entry without `to` to the managers only, and one with `to` to that approved person only', async () => {
        const t = await setup();
        await t.notifications.syncAttention(
            t.target,
            [
                { kind: 'tool-sign-in', count: 1 },
                { to: t.member.userId, kind: 'agent-waiting', count: 2 },
                // Not approved, not in the team, not a dashboard user at all: dropped without a trace.
                { to: t.waiting.userId, kind: 'agent-waiting', count: 1 },
                { to: t.outsider.userId, kind: 'agent-waiting', count: 1 },
                { to: 'someone-the-engine-made-up', kind: 'task-failed', count: 1 },
            ],
            signal,
        );
        const names = new Map([t.owner, t.admin, t.member, t.unverified].map((p, i) => [p.userId, String(i)]));
        expect(
            t
                .open()
                .map((row) => `${names.get(row.userId) ?? '?'} ${row.kind} ${String(row.count)}`)
                .sort(),
        ).toEqual(['0 tool-sign-in 1', '1 tool-sign-in 1', '2 agent-waiting 2', '3 tool-sign-in 1']);
        expect(t.rowOf(t.member.userId)).toMatchObject({ dueAt: START + 15 * 60_000, variant: null });
    });

    it('sums a person’s entries, lowers counts without re-arming, raises them re-armed, and closes what is gone', async () => {
        const t = await setup();
        await t.notifications.syncAttention(
            t.target,
            [
                { kind: 'agent-waiting', count: 1 },
                { to: t.admin.userId, kind: 'agent-waiting', count: 2 },
            ],
            signal,
        );
        expect(t.rowOf(t.admin.userId)).toMatchObject({ count: 3 });
        const id = t.rowOf(t.admin.userId)?.id ?? ('' as never);
        await t.store.markSeen(t.orgId, t.admin.userId, [id], START);
        t.clock.advance(60_000);
        await t.notifications.syncAttention(
            t.target,
            [{ to: t.admin.userId, kind: 'agent-waiting', count: 1 }],
            signal,
        );
        expect(t.rowOf(t.admin.userId)).toMatchObject({ count: 1, seenAt: START, dueAt: START + 15 * 60_000 });
        expect(t.rowOf(t.owner.userId)).toBeUndefined();
        const before = structuredClone(t.store.rows);
        await t.notifications.syncAttention(
            t.target,
            [{ to: t.admin.userId, kind: 'agent-waiting', count: 1 }],
            signal,
        );
        expect(t.store.rows).toEqual(before);
        await t.notifications.syncAttention(
            t.target,
            [{ to: t.admin.userId, kind: 'agent-waiting', count: 4 }],
            signal,
        );
        expect(t.rowOf(t.admin.userId)).toMatchObject({ count: 4, seenAt: null, dueAt: START + 60_000 + 15 * 60_000 });
        // Absent (switched off) or empty: every engine row of the project closes.
        await t.notifications.syncAttention(t.target, [], signal);
        expect(t.open()).toEqual([]);
    });

    it('closes the rows of someone who left the team, and respects a person’s own channel', async () => {
        const t = await setup();
        await t.store.setOverride(t.orgId, t.owner.userId, 'tool-sign-in', 'in-app');
        await t.notifications.syncAttention(t.target, [{ kind: 'tool-sign-in', count: 1 }], signal);
        expect(t.rowOf(t.owner.userId)).toMatchObject({ dueAt: null });
        t.directory.setPeople(t.orgId, [t.owner]);
        await t.notifications.syncAttention(t.target, [{ kind: 'tool-sign-in', count: 1 }], signal);
        expect(t.rowOf(t.admin.userId)).toBeUndefined();
        expect(t.rowOf(t.owner.userId)).toBeDefined();
    });
});
