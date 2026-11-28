import { z } from 'zod';

/**
 * Notification kinds (ADR 0027) as data: one definition per kind, read by the Worker's pipeline and email and by the
 * SPA's bell and settings, so the two never disagree on ids, defaults or copy. Every value a definition may render is
 * the dashboard's own: the project's label and hostname, the organization's name, a closed variant, a count and times.
 */

export type NotificationSource = 'platform' | 'engine';

/** What a person is to the project the notification is about; `team-admin` resolves to nobody until ADR 0026. */
export const RECIPIENT_ROLES = ['org-owner', 'org-admin', 'team-admin', 'member'] as const;
export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

/**
 * `email` is in-app plus an email if the notification is still unseen when it is due. A daily summary would be one more
 * value here, picked up by its own job.
 */
export const notificationChannelSchema = z.enum(['off', 'in-app', 'email']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export type ChannelDefaults = Readonly<Record<RecipientRole, NotificationChannel>>;

/**
 * Who may hear about an event, as the recipient directory resolves it, at the event and again at send time.
 * - `project-viewers`: org owners and admins, and the people of the project's team.
 * - `project-managers`: who linked the project, and org owners, admins and team admins in its team with approved access.
 * - `org-managers`: org owners and admins, for organization-level kinds.
 * - `person`: one user, if they are still in the organization (and, for a project, still see it).
 */
export type Audience =
    | { readonly kind: 'project-viewers' }
    | { readonly kind: 'project-managers' }
    | { readonly kind: 'org-managers' }
    | { readonly kind: 'person'; readonly userId: string };

/** A person's open notification of one kind about one project (or organization), as `reduce` sees it. */
export interface OpenNotification<V extends string = string> {
    readonly count: number;
    readonly variant: V | null;
    readonly openedAt: number;
    readonly updatedAt: number;
    readonly seenAt: number | null;
    readonly emailedAt: number | null;
}

export type NotificationChange<V extends string = string> =
    | { readonly op: 'keep' }
    | { readonly op: 'close' }
    | {
          readonly op: 'put';
          readonly count: number;
          readonly variant: V | null;
          /** When what the row is about began, e.g. the last heartbeat before an outage. */
          readonly openedAt: number;
          /** Unseen and not emailed again, as if new; a count that only drops leaves both alone. */
          readonly rearm: boolean;
      };

export interface NotificationTiming<V extends string> {
    /** How long after `openedAt` (or a re-arm) its email is due; the offline alert's threshold already waited. */
    readonly emailDelayMs: number;
    /** At most one email per person and project per hour. Off for status emails, which were never capped. */
    readonly hourlyCap: boolean;
    /** Informational rows close a day after they were seen; a condition (an outage, a request) closes when it ends. */
    closesWhenSeen(variant: V | null): boolean;
    /** A row nothing touched for this long closes, so a lost close never keeps one forever. */
    readonly lifetimeMs: number;
}

/** The dashboard-owned facts a line may name. `project` is null for organization-level kinds. */
export interface NotificationPlace {
    readonly orgName: string | null;
    readonly project: { readonly label: string; readonly hostname: string } | null;
}

/** The project's label, for lines of kinds that always have a project; empty never shows, since those rows do. */
export function projectLabel(place: NotificationPlace): string {
    return place.project?.label ?? '';
}

export interface NotificationItem<V extends string = string> {
    readonly count: number;
    readonly variant: V | null;
    readonly openedAt: number;
    readonly updatedAt: number;
}

export interface RenderContext {
    readonly locale: 'en' | 'cs';
    /** Times as the reader expects them: the browser's zone in-app, UTC with its name in email. */
    readonly time: (ms: number) => string;
    /** "2 hours, 5 minutes". */
    readonly duration: (ms: number) => string;
}

/** Where Open goes. Only the dashboard's own pages and the project's registered hostname, never an item. */
export type NotificationLink =
    | { readonly to: 'project-page' }
    | { readonly to: 'project'; readonly path: '/' | '/members' }
    | { readonly to: 'dashboard'; readonly path: '/' | '/people' };

/** What an email adds that the dashboard owns but a row does not hold, read at send time. */
export interface EmailExtras {
    /** `join-request`: the addresses of the people the dashboard sent to the project who still wait. */
    readonly requesters: readonly string[];
}

export interface NotificationCopy<V extends string> {
    /** The settings row. */
    label(): string;
    /** The bell's line, and the email's for a merged message. */
    line(item: NotificationItem<V>, place: NotificationPlace, context: RenderContext): string;
    /** The subject when this is the only item of an email. */
    subject(item: NotificationItem<V>, place: NotificationPlace, context: RenderContext): string;
    /** The email paragraph under the line, if the kind has more to say; plain text. */
    detail?(
        item: NotificationItem<V>,
        place: NotificationPlace,
        context: RenderContext,
        extras: EmailExtras,
    ): string | null;
    link(item: NotificationItem<V>): NotificationLink;
}

/**
 * Who may still get the email when it is sent: whoever sees the project (or is in the organization), its managers, or
 * its managers and the people with approved access, the only ones an engine's per-person count may name.
 */
export type Reach = 'viewers' | 'managers' | 'managers-or-approved';

/** What every kind declares, whatever its source. */
export interface KindBase<K extends string, V extends string> {
    readonly id: K;
    readonly reach: Reach;
    readonly variants: readonly V[];
    readonly defaults: ChannelDefaults;
    readonly timing: NotificationTiming<V>;
    readonly copy: NotificationCopy<V>;
}

/** A kind the dashboard sees happen; its producer calls `notify` with an event. */
export interface PlatformKind<K extends string, E, V extends string> extends KindBase<K, V> {
    readonly source: 'platform';
    audience(event: E): Audience;
    reduce(row: OpenNotification<V> | null, event: E, now: number): NotificationChange<V>;
}

/** A kind the engine counts in its heartbeat's `attention`; rows are set from the counts, never from an event. */
export interface EngineKind<K extends string> extends KindBase<K, never> {
    readonly source: 'engine';
}

export function definePlatformKind<K extends string, E, V extends string = never>(
    kind: PlatformKind<K, E, V>,
): PlatformKind<K, E, V> {
    return kind;
}

export function defineEngineKind<K extends string>(kind: EngineKind<K>): EngineKind<K> {
    return kind;
}

/** Counted repeats: one open row whose count goes up; something new is unseen again and may be emailed again. */
export function countUp<V extends string>(
    row: OpenNotification<V> | null,
    by: number,
    variant: V | null,
    now: number,
): NotificationChange<V> {
    return row === null
        ? { op: 'put', count: by, variant, openedAt: now, rearm: true }
        : { op: 'put', count: row.count + by, variant, openedAt: row.openedAt, rearm: true };
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** ADR 0027: email only if a notification is still unseen 15 minutes after it opened. */
export const UNSEEN_EMAIL_DELAY_MS = 15 * MINUTE_MS;
