import type { EngineId } from '@ptbk/protocol';

import type { NotificationChannel } from '../../shared/notifications/notification-kind';
import type { NotificationKind } from '../../shared/notifications/registry';
import type { NotificationId, OrgId, UserId } from '../ids';

/**
 * One notification row (ADR 0027). Nothing in it comes from an engine but a count: the kind and variant are closed
 * enums, the rest are the dashboard's own IDs and times.
 */
export interface NotificationRecord {
    readonly id: NotificationId;
    readonly orgId: OrgId;
    readonly userId: UserId;
    /** Null for organization-level kinds. */
    readonly engineId: EngineId | null;
    readonly kind: NotificationKind;
    readonly variant: string | null;
    readonly count: number;
    readonly openedAt: number;
    readonly updatedAt: number;
    readonly seenAt: number | null;
    /** When an email last included it. */
    readonly emailedAt: number | null;
    /** When an email is owed; null when none is. */
    readonly dueAt: number | null;
    readonly closedAt: number | null;
}

export type OpenNotificationRecord = NotificationRecord & { readonly closedAt: null };

export type NotificationWrite =
    | { readonly op: 'insert'; readonly row: OpenNotificationRecord }
    | {
          readonly op: 'update';
          readonly id: NotificationId;
          readonly fields: Pick<
              NotificationRecord,
              'count' | 'variant' | 'openedAt' | 'updatedAt' | 'seenAt' | 'dueAt'
          >;
      }
    | { readonly op: 'close'; readonly id: NotificationId; readonly at: number };

/**
 * When rows of a kind go stale: seen before `seenBefore` with one of `seenVariants` (null for no variant), or untouched
 * since `untouchedBefore`, whatever their variant.
 */
export interface StaleRule {
    readonly kind: NotificationKind;
    readonly seenVariants: readonly (string | null)[];
    readonly seenBefore: number;
    readonly untouchedBefore: number;
}

/**
 * Notification rows and preferences in D1. Every read and write of a person's rows names the organization too; the
 * delivery job's reads are the only unscoped ones, and they hand rows to the job alone.
 */
export interface NotificationStore {
    /** The open rows of one kind about one project (or the organization), whoever they are for. */
    findOpen(
        orgId: OrgId,
        engineId: EngineId | null,
        kinds: readonly NotificationKind[],
    ): Promise<readonly OpenNotificationRecord[]>;
    /** All of them or none: one D1 batch. */
    write(writes: readonly NotificationWrite[]): Promise<void>;

    /** A person's open rows in one organization, newest first. */
    listOpen(orgId: OrgId, userId: UserId, limit: number): Promise<readonly OpenNotificationRecord[]>;
    /** Organizations where the person has an open row they have not seen. */
    orgsWithUnseen(userId: UserId): Promise<readonly OrgId[]>;
    /** Marks the person's listed rows seen; rows of others or of another organization stay as they are. */
    markSeen(orgId: OrgId, userId: UserId, ids: readonly NotificationId[], at: number): Promise<void>;

    /** Open rows whose email is due by `now`, and was due after `since`, oldest due first. */
    due(now: number, since: number, limit: number): Promise<readonly OpenNotificationRecord[]>;
    /** The last email to the person about the project (or organization), from any of its rows, closed ones too. */
    lastEmailedAt(orgId: OrgId, userId: UserId, engineId: EngineId | null): Promise<number | null>;
    markEmailed(ids: readonly NotificationId[], at: number): Promise<void>;
    reschedule(ids: readonly NotificationId[], dueAt: number | null): Promise<void>;
    closeStale(rules: readonly StaleRule[], at: number): Promise<void>;
    deleteClosedBefore(at: number): Promise<void>;

    /** The person's overrides in the organization; kinds without one are absent. */
    overrides(orgId: OrgId, userId: UserId): Promise<ReadonlyMap<NotificationKind, NotificationChannel>>;
    /** Several people's overrides of some kinds, keyed `userId|kind`. */
    overridesFor(
        orgId: OrgId,
        userIds: readonly UserId[],
        kinds: readonly NotificationKind[],
    ): Promise<ReadonlyMap<string, NotificationChannel>>;
    /** `null` removes the override, so the role's default applies again. */
    setOverride(
        orgId: OrgId,
        userId: UserId,
        kind: NotificationKind,
        channel: NotificationChannel | null,
    ): Promise<void>;
}

export function overrideKey(userId: UserId, kind: NotificationKind): string {
    return `${userId}|${kind}`;
}
