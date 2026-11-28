import type { EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import { newNotificationId, type OrgId, type UserId } from '../domain/ids';
import type { NotificationStore, OpenNotificationRecord } from '../domain/notifications/notification-store';
import { createTestEngine } from './test-engine';

export interface NotificationStoreFixture {
    readonly store: NotificationStore;
    /** An organization with these users in it, as the foreign keys need. */
    addOrg(userCount: number): Promise<{ readonly orgId: OrgId; readonly userIds: readonly UserId[] }>;
}

/** One suite, run against the D1 and the in-memory notification stores. */
export function describeNotificationStoreContract(name: string, makeFixture: () => NotificationStoreFixture): void {
    describe(`NotificationStore contract: ${name}`, () => {
        let fixture: NotificationStoreFixture;
        let orgId: OrgId;
        let ada: UserId;
        let bob: UserId;
        let engineId: EngineId;

        beforeEach(async () => {
            fixture = makeFixture();
            const org = await fixture.addOrg(2);
            orgId = org.orgId;
            [ada, bob] = org.userIds as [UserId, UserId];
            engineId = (await createTestEngine()).engineId;
        });

        const row = (overrides: Partial<OpenNotificationRecord> = {}): OpenNotificationRecord => ({
            id: newNotificationId(cryptoRandom),
            orgId,
            userId: ada,
            engineId,
            kind: 'agent-waiting',
            variant: null,
            count: 1,
            openedAt: 100,
            updatedAt: 100,
            seenAt: null,
            emailedAt: null,
            dueAt: null,
            closedAt: null,
            ...overrides,
        });

        it('writes, finds and updates open rows by organization, project and kind', async () => {
            const project = row();
            const org = row({ engineId: null, kind: 'people-change', variant: 'joined' });
            await fixture.store.write([
                { op: 'insert', row: project },
                { op: 'insert', row: org },
            ]);
            expect(await fixture.store.findOpen(orgId, engineId, ['agent-waiting', 'task-failed'])).toEqual([project]);
            expect(await fixture.store.findOpen(orgId, null, ['people-change'])).toEqual([org]);
            expect(await fixture.store.findOpen(orgId, null, ['agent-waiting'])).toEqual([]);
            const fields = { count: 3, variant: null, openedAt: 100, updatedAt: 200, seenAt: null, dueAt: 900 };
            await fixture.store.write([{ op: 'update', id: project.id, fields }]);
            expect(await fixture.store.findOpen(orgId, engineId, ['agent-waiting'])).toEqual([
                { ...project, ...fields },
            ]);
        });

        it('keeps one open row per person, organization, project and kind, and writes a batch all or nothing', async () => {
            const first = row();
            await fixture.store.write([{ op: 'insert', row: first }]);
            await expect(
                fixture.store.write([
                    { op: 'insert', row: row({ kind: 'task-failed' }) },
                    { op: 'insert', row: row() },
                ]),
            ).rejects.toThrow();
            expect(await fixture.store.findOpen(orgId, engineId, ['agent-waiting', 'task-failed'])).toEqual([first]);
            const orgLevel = row({ engineId: null, kind: 'people-change' });
            await fixture.store.write([{ op: 'insert', row: orgLevel }]);
            await expect(
                fixture.store.write([{ op: 'insert', row: row({ engineId: null, kind: 'people-change' }) }]),
            ).rejects.toThrow();
            // Closing first frees the key for a fresh row in the same batch.
            const fresh = row({ count: 2 });
            await fixture.store.write([
                { op: 'close', id: first.id, at: 300 },
                { op: 'insert', row: fresh },
            ]);
            expect(await fixture.store.findOpen(orgId, engineId, ['agent-waiting'])).toEqual([fresh]);
        });

        it('lists a person’s open rows newest first, says where they have unseen ones, and marks only theirs seen', async () => {
            const older = row({ updatedAt: 100 });
            const newer = row({ kind: 'task-failed', updatedAt: 200 });
            const bobs = row({ userId: bob });
            await fixture.store.write([older, newer, bobs].map((r) => ({ op: 'insert', row: r }) as const));
            expect((await fixture.store.listOpen(orgId, ada, 50)).map((r) => r.id)).toEqual([newer.id, older.id]);
            expect(await fixture.store.listOpen(orgId, ada, 1)).toHaveLength(1);
            expect(await fixture.store.orgsWithUnseen(ada)).toEqual([orgId]);
            await fixture.store.markSeen(orgId, ada, [older.id, newer.id, bobs.id], 500);
            expect(await fixture.store.orgsWithUnseen(ada)).toEqual([]);
            expect((await fixture.store.listOpen(orgId, bob, 50))[0]?.seenAt).toBeNull();
            await fixture.store.markSeen(orgId, ada, [older.id], 900);
            expect((await fixture.store.listOpen(orgId, ada, 50)).find((r) => r.id === older.id)?.seenAt).toBe(500);
        });

        it('hands the job what is due in its window, and remembers the last email of closed rows too', async () => {
            const due = row({ dueAt: 1000 });
            const later = row({ kind: 'task-failed', dueAt: 2000 });
            const stale = row({ kind: 'tool-sign-in', dueAt: 10 });
            const none = row({ userId: bob });
            await fixture.store.write([due, later, stale, none].map((r) => ({ op: 'insert', row: r }) as const));
            // The job's read spans every organization; this suite looks at its own rows only.
            const dueIds = async (now: number) =>
                (await fixture.store.due(now, 100, 100)).filter((r) => r.orgId === orgId).map((r) => r.id);
            expect(await dueIds(1500)).toEqual([due.id]);
            await fixture.store.reschedule([due.id], 3000);
            expect(await dueIds(2500)).toEqual([later.id]);
            await fixture.store.markEmailed([later.id], 2600);
            expect(await dueIds(5000)).toEqual([due.id]);
            await fixture.store.write([{ op: 'close', id: later.id, at: 2700 }]);
            expect(await fixture.store.lastEmailedAt(orgId, ada, engineId)).toBe(2600);
            expect(await fixture.store.lastEmailedAt(orgId, ada, null)).toBeNull();
            expect(await fixture.store.lastEmailedAt(orgId, bob, engineId)).toBeNull();
        });

        it('closes stale rows by kind, variant and age, and deletes closed rows once old enough', async () => {
            const seenNotice = row({ engineId: null, kind: 'people-change', variant: 'joined', seenAt: 50 });
            const seenOutage = row({ kind: 'project-status', variant: 'offline', seenAt: 50 });
            const untouched = row({ kind: 'task-failed', updatedAt: 10 });
            const fresh = row();
            await fixture.store.write(
                [seenNotice, seenOutage, untouched, fresh].map((r) => ({ op: 'insert', row: r }) as const),
            );
            await fixture.store.markEmailed([untouched.id], 15);
            await fixture.store.closeStale(
                [
                    { kind: 'people-change', seenVariants: [null, 'joined'], seenBefore: 60, untouchedBefore: 0 },
                    { kind: 'project-status', seenVariants: ['back-online'], seenBefore: 60, untouchedBefore: 0 },
                    { kind: 'task-failed', seenVariants: [], seenBefore: 60, untouchedBefore: 20 },
                    { kind: 'agent-waiting', seenVariants: [], seenBefore: 60, untouchedBefore: 20 },
                ],
                70,
            );
            expect((await fixture.store.listOpen(orgId, ada, 50)).map((r) => r.id).sort()).toEqual(
                [seenOutage.id, fresh.id].sort(),
            );
            await fixture.store.deleteClosedBefore(70);
            expect(await fixture.store.lastEmailedAt(orgId, ada, engineId)).toBe(15);
            await fixture.store.deleteClosedBefore(71);
            expect(await fixture.store.lastEmailedAt(orgId, ada, engineId)).toBeNull();
        });

        it('stores overrides only, per person, organization and kind', async () => {
            expect(await fixture.store.overrides(orgId, ada)).toEqual(new Map());
            await fixture.store.setOverride(orgId, ada, 'agent-waiting', 'off');
            await fixture.store.setOverride(orgId, ada, 'agent-waiting', 'in-app');
            await fixture.store.setOverride(orgId, ada, 'task-failed', 'email');
            await fixture.store.setOverride(orgId, bob, 'agent-waiting', 'off');
            expect(await fixture.store.overrides(orgId, ada)).toEqual(
                new Map([
                    ['agent-waiting', 'in-app'],
                    ['task-failed', 'email'],
                ]),
            );
            expect(await fixture.store.overridesFor(orgId, [ada, bob], ['agent-waiting'])).toEqual(
                new Map([
                    [`${ada}|agent-waiting`, 'in-app'],
                    [`${bob}|agent-waiting`, 'off'],
                ]),
            );
            await fixture.store.setOverride(orgId, ada, 'agent-waiting', null);
            expect(await fixture.store.overrides(orgId, ada)).toEqual(new Map([['task-failed', 'email']]));
            const other = await fixture.addOrg(0);
            expect(await fixture.store.overrides(other.orgId, ada)).toEqual(new Map());
        });
    });
}
