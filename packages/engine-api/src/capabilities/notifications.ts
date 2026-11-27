import { z } from 'zod';

import { AgentId, AiToolId, ChatId, Cursor, PageQuery, RunId, TaskId, Timestamp, pageOf } from '../common';
import { defineRoute } from '../route';
import { openEnum, toTolerant } from '../tolerant';
import { KNOWN_CAPABILITIES } from './capability';

/**
 * `notifications@1` (C-21, ADR 0027): the engine's inbox. Items carry their content and stay on the engine; the
 * dashboard learns only how many unseen ones of each kind wait for whom, through the heartbeat's `attention`, and only
 * while the owner lets it (`Settings.dashboardAttention`). Design and test cases:
 * docs/engine-integration/engine-api.md#notifications.
 */

/**
 * The same closed list as the heartbeat's `AttentionKind` in `@ptbk/protocol`, which this package cannot import; the
 * conformance suite checks that they match. A new kind is an addition in the same version.
 */
export const NOTIFICATION_KINDS = ['agent-waiting', 'task-failed', 'tool-sign-in'] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/**
 * `personal`: for the caller alone. `project`: for everyone holding `settings.manage`, and seen for all of them once
 * one of them has seen it, since the dashboard gets one count for the project's managers.
 */
export const NOTIFICATION_AUDIENCES = ['personal', 'project'] as const;

export const MAX_NOTIFICATION_TITLE_LENGTH = 200;
export const MAX_NOTIFICATION_DETAIL_LENGTH = 2_000;
/** IDs per mark-seen request: one page of the inbox at its largest. */
export const MAX_NOTIFICATIONS_PER_SEEN = 100;

export const NotificationId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .brand<'NotificationId', 'inout'>();
export type NotificationId = z.infer<typeof NotificationId>;

/** Where the item is handled: the UI links there. */
export const NotificationTarget = z.discriminatedUnion('kind', [
    /** An agent waits in this chat: a question, an approval. */
    z.strictObject({ kind: z.literal('chat'), agentId: AgentId, chatId: ChatId }),
    z.strictObject({ kind: z.literal('run'), runId: RunId }),
    z.strictObject({ kind: z.literal('task'), taskId: TaskId }),
    /** The AI tool to sign in again (`ai-tools@1`). */
    z.strictObject({ kind: z.literal('ai-tool'), aiToolId: AiToolId }),
]);
export type NotificationTarget = z.infer<typeof NotificationTarget>;

/** Plain text from the engine, possibly written by an agent: the UI shows it as text and never as markup. */
const notificationShape = {
    id: NotificationId,
    kind: NotificationKind,
    audience: z.enum(NOTIFICATION_AUDIENCES),
    title: z.string().trim().min(1).max(MAX_NOTIFICATION_TITLE_LENGTH),
    detail: z.string().trim().min(1).max(MAX_NOTIFICATION_DETAIL_LENGTH).nullable(),
    /** `null` when there is nothing to open, e.g. the run was deleted. */
    target: NotificationTarget.nullable(),
    createdAt: Timestamp,
    /** When the caller (for `project` items: any manager) first saw it in the engine UI; `null` while unseen. */
    seenAt: Timestamp.nullable(),
};

/**
 * One open item. Handling it (answering the agent, retrying the task, signing the tool in) closes it, and a closed item
 * leaves the inbox; seeing it only sets `seenAt`.
 */
export const Notification = z.strictObject(notificationShape);
export type Notification = z.infer<typeof Notification>;
export const NotificationPage = pageOf(Notification);

const tolerantTarget = toTolerant(NotificationTarget);

/**
 * The client's reading of one item: an unknown kind reads as `unknown` and an unknown or broken target as `null`, so
 * a newer engine's items still show with their text.
 */
export const NotificationReader = z.object({
    ...notificationShape,
    kind: openEnum(NOTIFICATION_KINDS),
    audience: openEnum(NOTIFICATION_AUDIENCES),
    target: z.unknown().transform((raw) => {
        const parsed = tolerantTarget.safeParse(raw);
        return parsed.success ? parsed.data : null;
    }),
});
export type ReadNotification = z.output<typeof NotificationReader>;
export const NotificationPageReader = z.object({ items: z.array(NotificationReader), nextCursor: Cursor.nullable() });

/** The heartbeat's `MAX_HEARTBEAT_COUNT`. */
const Count = z.int().min(0).max(1_000_000);

/**
 * The caller's unseen open items: what the inbox badge shows. `total` also counts kinds a client may not know yet.
 * Project-wide items count for every member holding `settings.manage`.
 */
export const NotificationCounts = z.strictObject({
    total: Count,
    byKind: z.strictObject({ 'agent-waiting': Count, 'task-failed': Count, 'tool-sign-in': Count }),
});
export type NotificationCounts = z.infer<typeof NotificationCounts>;

export const MarkNotificationsSeenBody = z.strictObject({
    ids: z.array(NotificationId).min(1).max(MAX_NOTIFICATIONS_PER_SEEN),
});

export const DashboardAttention = z.strictObject({ enabled: z.boolean() });
export type DashboardAttention = z.infer<typeof DashboardAttention>;

const capability = KNOWN_CAPABILITIES.notifications;

const OWN_ITEMS =
    'Only the caller’s own items and, for members holding `settings.manage`, the project-wide ones; nobody sees ' +
    'anyone else’s.';

export const NOTIFICATION_ROUTES = {
    listMyNotifications: defineRoute({
        id: 'listMyNotifications',
        method: 'GET',
        path: '/me/notifications',
        summary: 'List the caller’s open notifications with their content, newest first',
        description: OWN_ITEMS,
        permission: null,
        capability,
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: NotificationPage, read: NotificationPageReader } },
    }),
    getMyNotificationCounts: defineRoute({
        id: 'getMyNotificationCounts',
        method: 'GET',
        path: '/me/notifications/unseen',
        summary: 'Count the caller’s unseen open notifications, per kind',
        description:
            `${OWN_ITEMS} These are the numbers the heartbeat’s \`attention\` carries for the caller, while the owner ` +
            'shares them and the caller joined with a dashboard ticket.',
        permission: null,
        capability,
        responses: { 200: { kind: 'json', schema: NotificationCounts } },
    }),
    markMyNotificationsSeen: defineRoute({
        id: 'markMyNotificationsSeen',
        method: 'POST',
        path: '/me/notifications/seen',
        summary: 'Mark notifications seen; answers the caller’s unseen counts afterwards',
        description:
            'All or nothing: an ID that is unknown, closed or not the caller’s to see is 404 `not-found` and marks ' +
            'none, never 403, so IDs cannot be probed. Marking a seen item again keeps its first `seenAt`.',
        permission: null,
        capability,
        body: { kind: 'json', schema: MarkNotificationsSeenBody },
        responses: { 200: { kind: 'json', schema: NotificationCounts } },
    }),
    setDashboardAttention: defineRoute({
        id: 'setDashboardAttention',
        method: 'PUT',
        path: '/settings/dashboard-attention',
        summary: 'Let the heartbeat carry unseen notification counts per person, or stop it',
        description:
            'On, every heartbeat carries `attention` (an empty list when nothing waits); off, the field is left out ' +
            'from the next heartbeat on, and notifications stay inside the engine. On by default, off by default in ' +
            'strict mode. Audited as `settings.dashboard-attention`.',
        permission: 'settings.manage',
        capability,
        body: { kind: 'json', schema: DashboardAttention },
        responses: { 200: { kind: 'json', schema: DashboardAttention } },
        stepUp: true,
    }),
} as const;
