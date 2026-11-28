import { z } from 'zod';

import { agentWaitingKind, taskFailedKind, toolSignInKind } from './kinds/engine-attention';
import { joinRequestKind } from './kinds/join-request';
import { peopleChangeKind } from './kinds/people-change';
import { planLimitKind } from './kinds/plan-limit';
import { projectStatusKind } from './kinds/project-status';
import { updateWaitingKind } from './kinds/update-waiting';
import type {
    KindBase,
    NotificationChannel,
    NotificationSource,
    PlatformKind,
    RecipientRole,
} from './notification-kind';

/** Every kind, in the order the settings list them. Adding a kind is a definition here, its messages and a test. */
export const NOTIFICATION_KINDS = {
    'project-status': projectStatusKind,
    'update-waiting': updateWaitingKind,
    'join-request': joinRequestKind,
    'people-change': peopleChangeKind,
    'plan-limit': planLimitKind,
    'agent-waiting': agentWaitingKind,
    'task-failed': taskFailedKind,
    'tool-sign-in': toolSignInKind,
} as const;

type Kinds = typeof NOTIFICATION_KINDS;
export type NotificationKind = keyof Kinds;

export const NOTIFICATION_KIND_IDS = Object.keys(NOTIFICATION_KINDS) as [NotificationKind, ...NotificationKind[]];
/** Closed: a kind no definition names fails to parse, from the database too. */
export const notificationKindSchema = z.enum(NOTIFICATION_KIND_IDS);

export type PlatformNotificationKind = {
    [K in NotificationKind]: Kinds[K] extends { readonly source: 'platform' } ? K : never;
}[NotificationKind];
export type EngineNotificationKind = Exclude<NotificationKind, PlatformNotificationKind>;

/** What a platform kind's producer passes to `notify`. */
export type NotificationEvent<K extends PlatformNotificationKind> =
    Kinds[K] extends PlatformKind<K, infer E, string> ? E : never;

type VariantOf<K extends NotificationKind> = Kinds[K]['variants'][number];

/** A kind's definition with its own event type, for the pipeline's one generic path. */
export function platformKind<K extends PlatformNotificationKind>(
    kind: K,
): PlatformKind<K, NotificationEvent<K>, VariantOf<K>> {
    // Each entry is exactly that type; the indexed access only loses the correlation between `K` and its entry.
    return NOTIFICATION_KINDS[kind] as unknown as PlatformKind<K, NotificationEvent<K>, VariantOf<K>>;
}

/** A kind as the generic code reads it: copy, timing and defaults over any variant, never its events. */
export type AnyNotificationKind = KindBase<NotificationKind, string> & { readonly source: NotificationSource };

export function anyKind(kind: NotificationKind): AnyNotificationKind {
    // Rows carry a parsed variant of their own kind, so widening the variant type loses nothing at runtime.
    return NOTIFICATION_KINDS[kind];
}

export function isEngineKind(kind: NotificationKind): kind is EngineNotificationKind {
    return NOTIFICATION_KINDS[kind].source === 'engine';
}

/** A variant of the kind, or null for anything else: rows are parsed, never trusted. */
export function parseVariant(kind: NotificationKind, value: string | null): string | null {
    return value !== null && anyKind(kind).variants.includes(value) ? value : null;
}

/**
 * The one place a channel is chosen: the person's own override, else their role's default. Organization defaults
 * would slot in between when they come.
 */
export function effectiveChannel(
    kind: NotificationKind,
    role: RecipientRole,
    override: NotificationChannel | null,
): NotificationChannel {
    return override ?? NOTIFICATION_KINDS[kind].defaults[role];
}
