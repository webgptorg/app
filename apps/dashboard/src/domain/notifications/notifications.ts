import type { EngineId, HeartbeatAttention } from '@ptbk/protocol';

import type { NotificationChange, NotificationChannel } from '../../shared/notifications/notification-kind';
import {
    anyKind,
    effectiveChannel,
    NOTIFICATION_KINDS,
    platformKind,
    type EngineNotificationKind,
    type NotificationEvent,
    type NotificationKind,
    type PlatformNotificationKind,
} from '../../shared/notifications/registry';
import { newNotificationId, type OrgId, type UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Random } from '../ports/random';
import {
    overrideKey,
    type NotificationStore,
    type NotificationWrite,
    type OpenNotificationRecord,
} from './notification-store';
import type { NotificationRecipient, RecipientDirectory } from './recipient-directory';

export interface NotificationsDeps {
    readonly store: NotificationStore;
    readonly directory: RecipientDirectory;
    readonly clock: Clock;
    readonly random: Random;
}

export interface NotificationTarget {
    readonly orgId: OrgId;
    /** Null for organization-level kinds. */
    readonly engineId: EngineId | null;
}

/**
 * One entry of a heartbeat's `attention` (ADR 0027, C-21), as the protocol parsed it. Its kind must be one of the
 * registry's engine kinds: a kind the protocol adds without a definition here fails to compile where heartbeats are
 * handed over.
 */
export type AttentionEntry = HeartbeatAttention & { readonly kind: EngineNotificationKind };

const ENGINE_KINDS = (Object.keys(NOTIFICATION_KINDS) as NotificationKind[]).filter(
    (kind): kind is EngineNotificationKind => NOTIFICATION_KINDS[kind].source === 'engine',
);

export interface Notifications {
    /** A platform kind's producer: the event goes to the kind's audience and changes each person's one open row. */
    notify<K extends PlatformNotificationKind>(
        kind: K,
        target: NotificationTarget,
        event: NotificationEvent<K>,
        signal: AbortSignal,
    ): Promise<void>;
    /** The engine's counts as of a heartbeat: rows are set to them, and a kind that is gone closes. */
    syncAttention(
        target: NotificationTarget & { readonly engineId: EngineId },
        entries: readonly AttentionEntry[],
        signal: AbortSignal,
    ): Promise<void>;
}

interface Planned {
    readonly row: OpenNotificationRecord | null;
    readonly change: NotificationChange;
}

export function createNotifications(deps: NotificationsDeps): Notifications {
    /**
     * Turns each person's change into writes. Someone the audience no longer names, or who switched the kind off, can
     * only lose a row. A re-armed row that was emailed starts afresh, so the closed one keeps when it was emailed for
     * the hourly cap.
     */
    function plan(
        target: NotificationTarget,
        kind: NotificationKind,
        userId: UserId,
        channel: NotificationChannel,
        { row, change }: Planned,
        now: number,
    ): readonly NotificationWrite[] {
        const timing = anyKind(kind).timing;
        if (change.op === 'close' || channel === 'off') {
            return row === null ? [] : [{ op: 'close', id: row.id, at: now }];
        }
        if (change.op === 'keep') {
            return [];
        }
        // Only a count that drops keeps a row as it was; anything new is unseen and owes its email again.
        const kept = row !== null && !change.rearm ? row : null;
        const fields = {
            count: change.count,
            variant: change.variant,
            openedAt: change.openedAt,
            updatedAt: now,
            seenAt: kept === null ? null : kept.seenAt,
            dueAt: kept !== null ? kept.dueAt : channel === 'email' ? now + timing.emailDelayMs : null,
        };
        if (row !== null && !(change.rearm && row.emailedAt !== null)) {
            return [{ op: 'update', id: row.id, fields }];
        }
        const insert: NotificationWrite = {
            op: 'insert',
            row: {
                id: newNotificationId(deps.random),
                orgId: target.orgId,
                userId,
                engineId: target.engineId,
                kind,
                emailedAt: null,
                closedAt: null,
                ...fields,
            },
        };
        return row === null ? [insert] : [{ op: 'close', id: row.id, at: now }, insert];
    }

    async function overridesOf(
        orgId: OrgId,
        userIds: readonly UserId[],
        kinds: readonly NotificationKind[],
    ): Promise<(userId: UserId, kind: NotificationKind) => NotificationChannel | null> {
        const overrides =
            userIds.length === 0
                ? new Map<string, NotificationChannel>()
                : await deps.store.overridesFor(orgId, userIds, kinds);
        return (userId, kind) => overrides.get(overrideKey(userId, kind)) ?? null;
    }

    return {
        async notify(kind, target, event, signal) {
            const definition = platformKind(kind);
            const now = deps.clock.nowMs();
            const [recipients, open] = await Promise.all([
                deps.directory.resolve(target.orgId, target.engineId, definition.audience(event), signal),
                deps.store.findOpen(target.orgId, target.engineId, [kind]),
            ]);
            const byUser = new Map<UserId, NotificationRecipient | null>(open.map((row) => [row.userId, null]));
            for (const recipient of recipients) {
                byUser.set(recipient.userId, recipient);
            }
            const override = await overridesOf(target.orgId, [...byUser.keys()], [kind]);
            const writes = [...byUser].flatMap(([userId, recipient]) => {
                const row = open.find((candidate) => candidate.userId === userId) ?? null;
                // A row of this kind carries one of its variants: the store parses it against the kind.
                const change = definition.reduce(row as Parameters<typeof definition.reduce>[0], event, now);
                const channel =
                    recipient === null ? 'off' : effectiveChannel(kind, recipient.role, override(userId, kind));
                return plan(target, kind, userId, channel, { row, change }, now);
            });
            if (writes.length > 0) {
                await deps.store.write(writes);
            }
        },

        async syncAttention(target, entries, signal) {
            const now = deps.clock.nowMs();
            const [people, open] = await Promise.all([
                deps.directory.resolve(target.orgId, target.engineId, { kind: 'project-viewers' }, signal),
                deps.store.findOpen(target.orgId, target.engineId, ENGINE_KINDS),
            ]);
            const counts = new Map<string, number>();
            const add = (userId: UserId, kind: EngineNotificationKind, count: number) => {
                const key = overrideKey(userId, kind);
                counts.set(key, (counts.get(key) ?? 0) + count);
            };
            for (const entry of entries) {
                if (entry.to === undefined) {
                    for (const person of people.filter((candidate) => candidate.manager)) {
                        add(person.userId, entry.kind, entry.count);
                    }
                    continue;
                }
                // Only someone the dashboard sent there and the engine approved; anyone else is dropped unseen.
                const person = people.find((candidate) => candidate.userId === entry.to && candidate.approved);
                if (person !== undefined) {
                    add(person.userId, entry.kind, entry.count);
                }
            }
            const override = await overridesOf(
                target.orgId,
                [...new Set([...people.map((person) => person.userId), ...open.map((row) => row.userId)])],
                ENGINE_KINDS,
            );
            const keys = new Set([...counts.keys(), ...open.map((row) => overrideKey(row.userId, row.kind))]);
            const writes = [...keys].flatMap((key) => {
                const [userId, kind] = key.split('|') as [UserId, EngineNotificationKind];
                const row = open.find((candidate) => candidate.userId === userId && candidate.kind === kind) ?? null;
                const count = counts.get(key) ?? 0;
                const person = people.find((candidate) => candidate.userId === userId);
                const channel =
                    person === undefined ? 'off' : effectiveChannel(kind, person.role, override(userId, kind));
                const change: NotificationChange =
                    count === 0
                        ? { op: 'close' }
                        : row?.count === count
                          ? { op: 'keep' }
                          : {
                                op: 'put',
                                count,
                                variant: null,
                                openedAt: row?.openedAt ?? now,
                                rearm: row === null || count > row.count,
                            };
                return plan(target, kind, userId, channel, { row, change }, now);
            });
            if (writes.length > 0) {
                await deps.store.write(writes);
            }
        },
    };
}
