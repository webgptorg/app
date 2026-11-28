import type { NotificationId, OrgId, UserId } from '../domain/ids';
import {
    overrideKey,
    type NotificationRecord,
    type NotificationStore,
    type OpenNotificationRecord,
} from '../domain/notifications/notification-store';
import type { NotificationChannel } from '../shared/notifications/notification-kind';
import type { NotificationKind } from '../shared/notifications/registry';

export interface MemoryNotificationStore extends NotificationStore {
    /** Every row, closed ones too, in insertion order. */
    readonly rows: readonly NotificationRecord[];
}

/** The in-memory adapter: the same contract as D1 (notification-store-contract.ts), for unit tests and dev. */
export function createMemoryNotificationStore(): MemoryNotificationStore {
    const rows: NotificationRecord[] = [];
    const preferences = new Map<string, NotificationChannel>();
    const prefKey = (orgId: OrgId, userId: UserId, kind: NotificationKind) => `${orgId}|${overrideKey(userId, kind)}`;
    const isOpen = (row: NotificationRecord): row is OpenNotificationRecord => row.closedAt === null;
    const replace = (id: NotificationId, change: (row: NotificationRecord) => NotificationRecord) => {
        const index = rows.findIndex((row) => row.id === id);
        const row = rows[index];
        if (row !== undefined) {
            rows[index] = change(row);
        }
    };
    const openKeyTaken = (candidate: NotificationRecord, pending: readonly NotificationRecord[]) =>
        pending.some(
            (row) =>
                isOpen(row) &&
                row.id !== candidate.id &&
                row.userId === candidate.userId &&
                row.orgId === candidate.orgId &&
                row.engineId === candidate.engineId &&
                row.kind === candidate.kind,
        );
    return {
        rows,
        findOpen: (orgId, engineId, kinds) =>
            Promise.resolve(
                rows
                    .filter(isOpen)
                    .filter((row) => row.orgId === orgId && row.engineId === engineId && kinds.includes(row.kind)),
            ),
        write(writes) {
            // All or nothing, like D1's batch: applied to a copy, which replaces the rows only if every write holds.
            const next = rows.map((row) => ({ ...row }));
            for (const write of writes) {
                switch (write.op) {
                    case 'insert':
                        if (openKeyTaken(write.row, next) || next.some((row) => row.id === write.row.id)) {
                            return Promise.reject(new Error('UNIQUE constraint failed: notifications'));
                        }
                        next.push({ ...write.row });
                        break;
                    case 'update': {
                        const index = next.findIndex((row) => row.id === write.id);
                        const row = next[index];
                        if (row !== undefined) {
                            next[index] = { ...row, ...write.fields };
                        }
                        break;
                    }
                    case 'close': {
                        const index = next.findIndex((row) => row.id === write.id);
                        const row = next[index];
                        if (row !== undefined && isOpen(row)) {
                            next[index] = { ...row, closedAt: write.at, dueAt: null };
                        }
                        break;
                    }
                }
            }
            rows.splice(0, rows.length, ...next);
            return Promise.resolve();
        },
        listOpen: (orgId, userId, limit) =>
            Promise.resolve(
                rows
                    .filter(isOpen)
                    .filter((row) => row.orgId === orgId && row.userId === userId)
                    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
                    .slice(0, limit),
            ),
        orgsWithUnseen: (userId) =>
            Promise.resolve(
                [
                    ...new Set(
                        rows
                            .filter(isOpen)
                            .filter((row) => row.userId === userId && row.seenAt === null)
                            .map((row) => row.orgId),
                    ),
                ].sort(),
            ),
        markSeen(orgId, userId, ids, at) {
            for (const row of rows.filter(isOpen)) {
                if (row.orgId === orgId && row.userId === userId && ids.includes(row.id) && row.seenAt === null) {
                    replace(row.id, (current) => ({ ...current, seenAt: at }));
                }
            }
            return Promise.resolve();
        },
        due: (now, since, limit) =>
            Promise.resolve(
                rows
                    .filter(isOpen)
                    .filter((row) => row.dueAt !== null && row.dueAt <= now && row.dueAt > since)
                    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.id.localeCompare(b.id))
                    .slice(0, limit),
            ),
        lastEmailedAt(orgId, userId, engineId) {
            const times = rows
                .filter((row) => row.orgId === orgId && row.userId === userId && row.engineId === engineId)
                .flatMap((row) => (row.emailedAt === null ? [] : [row.emailedAt]));
            return Promise.resolve(times.length === 0 ? null : Math.max(...times));
        },
        markEmailed(ids, at) {
            for (const id of ids) {
                replace(id, (row) => ({ ...row, emailedAt: at, dueAt: null }));
            }
            return Promise.resolve();
        },
        reschedule(ids, dueAt) {
            for (const id of ids) {
                replace(id, (row) => (isOpen(row) ? { ...row, dueAt } : row));
            }
            return Promise.resolve();
        },
        closeStale(rules, at) {
            for (const rule of rules) {
                for (const row of rows.filter(isOpen).filter((candidate) => candidate.kind === rule.kind)) {
                    const seenStale =
                        row.seenAt !== null && row.seenAt < rule.seenBefore && rule.seenVariants.includes(row.variant);
                    if (row.updatedAt < rule.untouchedBefore || seenStale) {
                        replace(row.id, (current) => ({ ...current, closedAt: at, dueAt: null }));
                    }
                }
            }
            return Promise.resolve();
        },
        deleteClosedBefore(at) {
            const kept = rows.filter((row) => row.closedAt === null || row.closedAt >= at);
            rows.splice(0, rows.length, ...kept);
            return Promise.resolve();
        },
        overrides(orgId, userId) {
            const out = new Map<NotificationKind, NotificationChannel>();
            for (const [key, channel] of preferences) {
                const [org, user, kind] = key.split('|') as [string, string, NotificationKind];
                if (org === orgId && user === userId) {
                    out.set(kind, channel);
                }
            }
            return Promise.resolve(out);
        },
        overridesFor(orgId, userIds, kinds) {
            const out = new Map<string, NotificationChannel>();
            for (const userId of userIds) {
                for (const kind of kinds) {
                    const channel = preferences.get(prefKey(orgId, userId, kind));
                    if (channel !== undefined) {
                        out.set(overrideKey(userId, kind), channel);
                    }
                }
            }
            return Promise.resolve(out);
        },
        setOverride(orgId, userId, kind, channel) {
            if (channel === null) {
                preferences.delete(prefKey(orgId, userId, kind));
            } else {
                preferences.set(prefKey(orgId, userId, kind), channel);
            }
            return Promise.resolve();
        },
    };
}
