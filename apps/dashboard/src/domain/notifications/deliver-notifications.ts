import type { EngineId } from '@ptbk/protocol';

import {
    DAY_MS,
    HOUR_MS,
    MINUTE_MS,
    type NotificationChannel,
    type NotificationLink,
    type Reach,
} from '../../shared/notifications/notification-kind';
import {
    anyKind,
    effectiveChannel,
    isEngineKind,
    NOTIFICATION_KIND_IDS,
    type NotificationKind,
} from '../../shared/notifications/registry';
import type { OrgId, UserId } from '../ids';
import type { EmailMessage, EmailSender, NotificationEmailItem } from '../ports/email-sender';
import type { Logger } from '../ports/logger';
import type { NotificationStore, OpenNotificationRecord, StaleRule } from './notification-store';
import type { NotificationRecipient, ProjectPlace, RecipientDirectory } from './recipient-directory';
import type { UnsubscribeTokens } from './unsubscribe-tokens';

export interface NotificationDeliveryDeps {
    readonly store: NotificationStore;
    readonly directory: RecipientDirectory;
    readonly email: EmailSender;
    readonly tokens: UnsubscribeTokens;
    readonly logger: Logger;
    readonly dashboardOrigin: string;
}

/** Rows due longer ago than this are not chased any more: an email a day late is noise. */
export const DUE_WINDOW_MS = DAY_MS;
export const HOURLY_CAP_MS = HOUR_MS;
/** A failed send is tried again on a later run, inside the window. */
export const RETRY_DELAY_MS = 5 * MINUTE_MS;
/** Seen informational rows stay in the bell this long. */
export const SEEN_ROW_LINGER_MS = DAY_MS;
/** ADR 0027: closed rows go after 30 days, like heartbeat values. */
export const CLOSED_ROW_RETENTION_MS = 30 * DAY_MS;
/** Per run; a cron run every 5 minutes clears a backlog in a few runs. */
export const DELIVERY_BATCH = 200;
const SEND_TIMEOUT_MS = 10_000;
const REQUESTER_WINDOW_MS = 7 * DAY_MS;

export interface DeliveryReport {
    readonly emails: number;
    readonly failed: number;
}

function linkUrl(link: NotificationLink, origin: string, engineId: EngineId | null, place: ProjectPlace): string {
    switch (link.to) {
        case 'project-page':
            return engineId === null ? `${origin}/` : `${origin}/engines/${engineId}`;
        case 'project':
            return place.project === null ? `${origin}/` : `https://${place.project.hostname}${link.path}`;
        case 'dashboard':
            return `${origin}${link.path}`;
    }
}

function reaches(reach: Reach, person: NotificationRecipient): boolean {
    switch (reach) {
        case 'viewers':
            return true;
        case 'managers':
            return person.manager;
        case 'managers-or-approved':
            return person.manager || person.approved;
    }
}

/**
 * Whether the person may still get this row's email now: still reached by the kind, still asking for email, with a
 * verified address, and (platform kinds) not seen in-app meanwhile. Engine counts are themselves the engine's word that
 * the items are unseen, so the bell does not hold them back.
 */
function stillOwed(
    row: OpenNotificationRecord,
    person: NotificationRecipient,
    override: NotificationChannel | null,
): boolean {
    const reached = reaches(anyKind(row.kind).reach, person);
    const channel = effectiveChannel(row.kind, person.role, override);
    return reached && person.emailVerified && channel === 'email' && (isEngineKind(row.kind) || row.seenAt === null);
}

/**
 * The 5-minute Cron Trigger (ADR 0027): what is due by `now` (the trigger's scheduled time), merged into one email per
 * person and project, recipients and preferences read again; then the cleanup.
 */
export async function runNotificationDelivery(
    deps: NotificationDeliveryDeps,
    now: number,
    signal: AbortSignal,
): Promise<DeliveryReport> {
    const due = await deps.store.due(now, now - DUE_WINDOW_MS, DELIVERY_BATCH);
    const groups = new Map<
        string,
        { readonly first: OpenNotificationRecord; readonly rows: OpenNotificationRecord[] }
    >();
    for (const row of due) {
        const key = `${row.orgId}|${row.userId}|${row.engineId ?? ''}`;
        const group = groups.get(key) ?? { first: row, rows: [] };
        group.rows.push(row);
        groups.set(key, group);
    }
    let emails = 0;
    let failed = 0;
    for (const { first, rows } of groups.values()) {
        signal.throwIfAborted();
        const outcome = await deliverGroup(deps, first, rows, now, signal);
        emails += outcome === 'sent' ? 1 : 0;
        failed += outcome === 'failed' ? 1 : 0;
    }
    await cleanUp(deps.store, now);
    if (failed > 0) {
        // Counts only: never who, about which project or kind.
        deps.logger.warn('notifications.send-failed', { failed, sent: emails });
    }
    return { emails, failed };
}

async function deliverGroup(
    deps: NotificationDeliveryDeps,
    { orgId, userId, engineId }: OpenNotificationRecord,
    rows: readonly OpenNotificationRecord[],
    now: number,
    signal: AbortSignal,
): Promise<'sent' | 'failed' | 'none'> {
    const [person, place, overrides] = await Promise.all([
        deps.directory.member(orgId, engineId, userId, signal),
        deps.directory.place(orgId, engineId, signal),
        deps.store.overrides(orgId, userId),
    ]);
    const owed =
        person === null || place === null || place.project?.active === false
            ? []
            : rows.filter((row) => stillOwed(row, person, overrides.get(row.kind) ?? null));
    const dropped = rows.filter((row) => !owed.includes(row));
    if (dropped.length > 0) {
        await deps.store.reschedule(
            dropped.map((row) => row.id),
            null,
        );
    }
    if (person === null || place === null || owed.length === 0) {
        return 'none';
    }
    const last = await deps.store.lastEmailedAt(orgId, userId, engineId);
    const capped = last !== null && now - last < HOURLY_CAP_MS;
    const held = capped ? owed.filter((row) => anyKind(row.kind).timing.hourlyCap) : [];
    if (held.length > 0 && last !== null) {
        await deps.store.reschedule(
            held.map((row) => row.id),
            last + HOURLY_CAP_MS,
        );
    }
    // In the registry's order, so a merged email reads the same however its rows came due.
    const sending = owed
        .filter((row) => !held.includes(row))
        .sort((a, b) => NOTIFICATION_KIND_IDS.indexOf(a.kind) - NOTIFICATION_KIND_IDS.indexOf(b.kind));
    if (sending.length === 0) {
        return 'none';
    }
    const message = await composeEmail(deps, { orgId, userId, engineId, person, place, rows: sending }, now, signal);
    try {
        await deps.email.send(message, AbortSignal.any([signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]));
    } catch {
        await deps.store.reschedule(
            sending.map((row) => row.id),
            now + RETRY_DELAY_MS,
        );
        return 'failed';
    }
    await deps.store.markEmailed(
        sending.map((row) => row.id),
        now,
    );
    return 'sent';
}

async function composeEmail(
    deps: NotificationDeliveryDeps,
    group: {
        readonly orgId: OrgId;
        readonly userId: UserId;
        readonly engineId: EngineId | null;
        readonly person: NotificationRecipient;
        readonly place: ProjectPlace;
        readonly rows: readonly OpenNotificationRecord[];
    },
    now: number,
    signal: AbortSignal,
): Promise<EmailMessage> {
    const { engineId, place } = group;
    const requesters =
        engineId !== null && group.rows.some((row) => row.kind === 'join-request')
            ? await deps.directory.waitingRequesters(engineId, now - REQUESTER_WINDOW_MS, signal)
            : [];
    const kinds = [...new Set(group.rows.map((row) => row.kind))];
    const token = await deps.tokens.sign({ userId: group.userId, orgId: group.orgId, kinds });
    const items = group.rows.map((row): NotificationEmailItem => ({
        kind: row.kind,
        variant: row.variant,
        count: row.count,
        openedAt: row.openedAt,
        updatedAt: row.updatedAt,
        link: linkUrl(anyKind(row.kind).copy.link(row), deps.dashboardOrigin, engineId, place),
    }));
    return {
        template: 'notifications',
        to: group.person.email,
        locale: group.person.locale,
        place: {
            orgName: place.orgName,
            project: place.project === null ? null : { label: place.project.label, hostname: place.project.hostname },
        },
        items,
        requesters,
        settingsLink: `${deps.dashboardOrigin}/account#notifications`,
        unsubscribe: {
            page: `${deps.dashboardOrigin}/unsubscribe#${encodeURIComponent(token)}`,
            oneClick: `${deps.dashboardOrigin}/email/unsubscribe?token=${encodeURIComponent(token)}`,
        },
    };
}

async function cleanUp(store: NotificationStore, now: number): Promise<void> {
    const rules: StaleRule[] = NOTIFICATION_KIND_IDS.map((kind: NotificationKind) => {
        const { timing, variants } = anyKind(kind);
        return {
            kind,
            seenVariants: [null, ...variants].filter((variant) => timing.closesWhenSeen(variant)),
            seenBefore: now - SEEN_ROW_LINGER_MS,
            untouchedBefore: now - timing.lifetimeMs,
        };
    });
    await store.closeStale(rules, now);
    await store.deleteClosedBefore(now - CLOSED_ROW_RETENTION_MS);
}
