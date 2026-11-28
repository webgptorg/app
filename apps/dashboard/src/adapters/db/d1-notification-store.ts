import { EngineId } from '@ptbk/protocol';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, lt, max, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import { notificationIdSchema, orgIdSchema, userIdSchema, type OrgId } from '../../domain/ids';
import {
    overrideKey,
    type NotificationStore,
    type OpenNotificationRecord,
} from '../../domain/notifications/notification-store';
import { notificationChannelSchema, type NotificationChannel } from '../../shared/notifications/notification-kind';
import { notificationKindSchema, parseVariant, type NotificationKind } from '../../shared/notifications/registry';
import type { Database } from './client';
import { notificationPreferences, notifications } from './schema';

const IN_CHUNK = 90;

/** D1 caps a statement's bound parameters at 100, so long ID lists go in chunks. */
function chunks<T>(values: readonly T[]): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < values.length; index += IN_CHUNK) {
        out.push(values.slice(index, index + IN_CHUNK));
    }
    return out;
}

type Row = typeof notifications.$inferSelect;

/** Parsed on every read: a row with a kind no definition names fails here, never further in. */
function toRecord(row: Row): OpenNotificationRecord {
    const kind = notificationKindSchema.parse(row.kind);
    return {
        id: notificationIdSchema.parse(row.id),
        orgId: orgIdSchema.parse(row.orgId),
        userId: userIdSchema.parse(row.userId),
        engineId: row.engineId === null ? null : EngineId.parse(row.engineId),
        kind,
        variant: parseVariant(kind, row.variant),
        count: row.count,
        openedAt: row.openedAt,
        updatedAt: row.updatedAt,
        seenAt: row.seenAt,
        emailedAt: row.emailedAt,
        dueAt: row.dueAt,
        closedAt: null,
    };
}

function engineIs(engineId: string | null): SQL {
    return engineId === null ? isNull(notifications.engineId) : eq(notifications.engineId, engineId);
}

export function createD1NotificationStore(db: Database): NotificationStore {
    const open = isNull(notifications.closedAt);
    return {
        async findOpen(orgId, engineId, kinds) {
            const rows = await db
                .select()
                .from(notifications)
                .where(
                    and(
                        eq(notifications.orgId, orgId),
                        engineIs(engineId),
                        inArray(notifications.kind, [...kinds]),
                        open,
                    ),
                )
                .all();
            return rows.map(toRecord);
        },

        async write(writes) {
            const statements = writes.map((write): BatchItem<'sqlite'> => {
                switch (write.op) {
                    case 'insert':
                        return db.insert(notifications).values(write.row);
                    case 'update':
                        return db.update(notifications).set(write.fields).where(eq(notifications.id, write.id));
                    case 'close':
                        return db
                            .update(notifications)
                            .set({ closedAt: write.at, dueAt: null })
                            .where(and(eq(notifications.id, write.id), open));
                }
            });
            const [first, ...rest] = statements;
            if (first !== undefined) {
                await db.batch([first, ...rest]);
            }
        },

        async listOpen(orgId, userId, limit) {
            const rows = await db
                .select()
                .from(notifications)
                .where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), open))
                .orderBy(desc(notifications.updatedAt), asc(notifications.id))
                .limit(limit)
                .all();
            return rows.map(toRecord);
        },

        async orgsWithUnseen(userId) {
            const rows = await db
                .selectDistinct({ orgId: notifications.orgId })
                .from(notifications)
                .where(and(eq(notifications.userId, userId), open, isNull(notifications.seenAt)))
                .orderBy(asc(notifications.orgId))
                .all();
            return rows.map((row) => orgIdSchema.parse(row.orgId));
        },

        async markSeen(orgId, userId, ids, at) {
            for (const part of chunks(ids)) {
                await db
                    .update(notifications)
                    .set({ seenAt: at })
                    .where(
                        and(
                            eq(notifications.orgId, orgId),
                            eq(notifications.userId, userId),
                            inArray(notifications.id, part),
                            isNull(notifications.seenAt),
                            open,
                        ),
                    );
            }
        },

        async due(now, since, limit) {
            const rows = await db
                .select()
                .from(notifications)
                .where(and(open, lte(notifications.dueAt, now), gt(notifications.dueAt, since)))
                .orderBy(asc(notifications.dueAt), asc(notifications.id))
                .limit(limit)
                .all();
            return rows.map(toRecord);
        },

        async lastEmailedAt(orgId, userId, engineId) {
            const row = await db
                .select({ at: max(notifications.emailedAt) })
                .from(notifications)
                .where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), engineIs(engineId)))
                .get();
            return row?.at ?? null;
        },

        async markEmailed(ids, at) {
            for (const part of chunks(ids)) {
                await db
                    .update(notifications)
                    .set({ emailedAt: at, dueAt: null })
                    .where(inArray(notifications.id, part));
            }
        },

        async reschedule(ids, dueAt) {
            for (const part of chunks(ids)) {
                await db
                    .update(notifications)
                    .set({ dueAt })
                    .where(and(inArray(notifications.id, part), open));
            }
        },

        async closeStale(rules, at) {
            for (const rule of rules) {
                const named = rule.seenVariants.filter((variant) => variant !== null);
                const seenVariant = or(
                    ...(rule.seenVariants.includes(null) ? [isNull(notifications.variant)] : []),
                    ...(named.length === 0 ? [] : [inArray(notifications.variant, named)]),
                );
                const seenStale =
                    seenVariant === undefined
                        ? undefined
                        : and(isNotNull(notifications.seenAt), lt(notifications.seenAt, rule.seenBefore), seenVariant);
                await db
                    .update(notifications)
                    .set({ closedAt: at, dueAt: null })
                    .where(
                        and(
                            eq(notifications.kind, rule.kind),
                            open,
                            or(lt(notifications.updatedAt, rule.untouchedBefore), seenStale),
                        ),
                    );
            }
        },

        async deleteClosedBefore(at) {
            await db
                .delete(notifications)
                .where(and(isNotNull(notifications.closedAt), lt(notifications.closedAt, at)));
        },

        async overrides(orgId, userId) {
            const rows = await db
                .select({ kind: notificationPreferences.kind, channel: notificationPreferences.channel })
                .from(notificationPreferences)
                .where(and(eq(notificationPreferences.orgId, orgId), eq(notificationPreferences.userId, userId)))
                .all();
            return new Map(
                rows.flatMap((row): [NotificationKind, NotificationChannel][] => {
                    const kind = notificationKindSchema.safeParse(row.kind);
                    // A kind that was removed from the registry leaves its overrides behind, unread.
                    return kind.success ? [[kind.data, notificationChannelSchema.parse(row.channel)]] : [];
                }),
            );
        },

        async overridesFor(orgId: OrgId, userIds, kinds) {
            const out = new Map<string, NotificationChannel>();
            for (const part of chunks(userIds)) {
                const rows = await db
                    .select()
                    .from(notificationPreferences)
                    .where(
                        and(
                            eq(notificationPreferences.orgId, orgId),
                            inArray(notificationPreferences.userId, part),
                            inArray(notificationPreferences.kind, [...kinds]),
                        ),
                    )
                    .all();
                for (const row of rows) {
                    out.set(
                        overrideKey(userIdSchema.parse(row.userId), notificationKindSchema.parse(row.kind)),
                        notificationChannelSchema.parse(row.channel),
                    );
                }
            }
            return out;
        },

        async setOverride(orgId, userId, kind, channel) {
            const key = and(
                eq(notificationPreferences.userId, userId),
                eq(notificationPreferences.orgId, orgId),
                eq(notificationPreferences.kind, kind),
            );
            if (channel === null) {
                await db.delete(notificationPreferences).where(key);
                return;
            }
            await db
                .insert(notificationPreferences)
                .values({ userId, orgId, kind, channel })
                .onConflictDoUpdate({
                    target: [
                        notificationPreferences.userId,
                        notificationPreferences.orgId,
                        notificationPreferences.kind,
                    ],
                    set: { channel: sql`excluded.channel` },
                });
        },
    };
}
