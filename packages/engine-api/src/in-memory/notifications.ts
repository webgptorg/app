import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import { Notification, NotificationId } from '../capabilities/notifications';
import type { NotificationCounts, NotificationKind, NotificationTarget } from '../capabilities/notifications';
import type { MemberId, Timestamp } from '../common';
import type { Permission } from '../permissions';
import { advertises, notFound, ok, page, sortBy, time } from './kit';
import type { EngineContext, Handlers, HandlerContext } from './kit';

/** Who manages the project, and so sees its project-wide items. */
const MANAGER_PERMISSION: Permission = 'settings.manage';
/** The heartbeat's caps (`MAX_HEARTBEAT_ATTENTION`, `MAX_HEARTBEAT_COUNT`), which this package cannot import. */
export const MAX_ATTENTION_ENTRIES = 64;
const MAX_ATTENTION_COUNT = 1_000_000;

export interface NotificationRecord {
    notification: Notification;
    /** `null`: project-wide, for every member holding `settings.manage`. */
    readonly memberId: MemberId | null;
    closedAt: Timestamp | null;
}

export interface NewNotification {
    /** `null` for a project-wide item. */
    readonly memberId: string | null;
    readonly kind: NotificationKind;
    readonly title: string;
    readonly detail?: string | null;
    readonly target?: NotificationTarget | null;
}

/** What the heartbeat's `attention` carries: no text, no item IDs, only who, what kind and how many. */
export interface AttentionEntry {
    readonly to?: string;
    readonly kind: NotificationKind;
    readonly count: number;
}

export function raiseNotification(ctx: EngineContext, input: NewNotification): Notification {
    if (input.memberId !== null && !ctx.state.members.has(input.memberId)) throw new Error('no such member');
    const notification = Notification.parse({
        id: ctx.newId(NotificationId, 'notification'),
        kind: input.kind,
        audience: input.memberId === null ? 'project' : 'personal',
        title: input.title,
        detail: input.detail ?? null,
        target: input.target ?? null,
        createdAt: ctx.now(),
        seenAt: null,
    });
    const memberId = input.memberId === null ? null : (ctx.state.members.get(input.memberId)?.id ?? null);
    ctx.state.notifications.set(notification.id, { notification, memberId, closedAt: null });
    return notification;
}

/** The item was handled; it leaves the inbox and every count. */
export function closeNotification(ctx: EngineContext, notificationId: string): boolean {
    const record = ctx.state.notifications.get(notificationId);
    if (record === undefined || record.closedAt !== null) return false;
    record.closedAt = ctx.now();
    return true;
}

const isOpen = (record: NotificationRecord): boolean => record.closedAt === null;
const isUnseen = (record: NotificationRecord): boolean => isOpen(record) && record.notification.seenAt === null;

function visibleTo(record: NotificationRecord, memberId: MemberId, permissions: ReadonlySet<Permission>): boolean {
    return record.memberId === null ? permissions.has(MANAGER_PERMISSION) : record.memberId === memberId;
}

function inbox(ctx: HandlerContext): NotificationRecord[] {
    return [...ctx.state.notifications.values()].filter(
        (record) => isOpen(record) && visibleTo(record, ctx.member.id, ctx.permissions),
    );
}

function countsOf(records: readonly NotificationRecord[]): NotificationCounts {
    const byKind = { 'agent-waiting': 0, 'task-failed': 0, 'tool-sign-in': 0 };
    for (const record of records) if (isUnseen(record)) byKind[record.notification.kind] += 1;
    return { total: Object.values(byKind).reduce((sum, count) => sum + count, 0), byKind };
}

/**
 * The `attention` entries the engine would send now, or `null` while the owner keeps it off or the engine lacks the
 * capability. Only active members who joined with a dashboard ticket are named; everyone else's personal items stay in
 * the engine UI. Over the cap, the largest counts win.
 */
export function attentionEntries(ctx: EngineContext): readonly AttentionEntry[] | null {
    if (!advertises(ctx, KNOWN_CAPABILITIES.notifications) || ctx.state.settings.dashboardAttention !== true) {
        return null;
    }
    const counts = new Map<string, { to: string | null; kind: NotificationKind; count: number }>();
    for (const record of ctx.state.notifications.values()) {
        if (!isUnseen(record)) continue;
        let to: string | null = null;
        if (record.memberId !== null) {
            const member = ctx.state.members.get(record.memberId);
            if (member?.status !== 'active' || member.dashboardUserId === null) continue;
            to = member.dashboardUserId;
        }
        const key = `${to ?? ''} ${record.notification.kind}`;
        const entry = counts.get(key) ?? { to, kind: record.notification.kind, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
    }
    return [...counts.values()]
        .sort((a, b) => b.count - a.count || `${a.to ?? ''}${a.kind}`.localeCompare(`${b.to ?? ''}${b.kind}`))
        .slice(0, MAX_ATTENTION_ENTRIES)
        .map(({ to, kind, count }) => ({
            ...(to === null ? {} : { to }),
            kind,
            count: Math.min(count, MAX_ATTENTION_COUNT),
        }));
}

/** An engine with the capability always has the switch; on unless the seed says otherwise. */
export function defaultDashboardAttention(capable: boolean, seeded: boolean | null): boolean | null {
    if (!capable) return null;
    return seeded ?? true;
}

export const NOTIFICATION_HANDLERS: Pick<
    Handlers,
    'listMyNotifications' | 'getMyNotificationCounts' | 'markMyNotificationsSeen' | 'setDashboardAttention'
> = {
    listMyNotifications: ({ query }, ctx) =>
        page(
            inbox(ctx).map(({ notification }) => notification),
            sortBy('createdAt', (notification) => time(notification.createdAt), true),
            query,
        ),
    getMyNotificationCounts: (_, ctx) => ok(countsOf(inbox(ctx))),
    markMyNotificationsSeen: ({ body }, ctx) => {
        const records = body.ids.map((id) => ctx.state.notifications.get(id));
        const mine = records.every(
            (record) => record !== undefined && isOpen(record) && visibleTo(record, ctx.member.id, ctx.permissions),
        );
        if (!mine) return notFound('notification');
        const at = ctx.now();
        for (const record of records) {
            if (record !== undefined && record.notification.seenAt === null) {
                record.notification = { ...record.notification, seenAt: at };
            }
        }
        return ok(countsOf(inbox(ctx)));
    },
    setDashboardAttention: ({ body }, ctx) => {
        ctx.state.settings = { ...ctx.state.settings, dashboardAttention: body.enabled };
        return ok({ enabled: body.enabled });
    },
};
