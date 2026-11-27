import { EngineId, SetupState } from '@ptbk/protocol';
import { z } from 'zod';

import { orgIdSchema, userIdSchema } from '../ids';
import { orgRoleSchema } from '../roles';

const none = z.strictObject({});

/**
 * Every event and what it may carry (ADR 0022). Props hold numbers, booleans and closed enums only: never a name, an
 * address, a token or other free text, so nothing typed by a person or sent by an engine can land in `usage_events`.
 */
export const USAGE_EVENT_PROPS = {
    /** A new account: email-first signup, or the one-step join from an invitation (D-31). */
    'account.signed_up': z.strictObject({ via: z.enum(['signup', 'invite']) }),
    'org.created': z.strictObject({ kind: z.enum(['personal', 'team']) }),
    /** A link code was issued: the engine exists in the dashboard but not yet on a machine. */
    'engine.created': z.strictObject({ forTeam: z.boolean() }),
    /** The engine redeemed a link code; `relinked` when its key was registered before. */
    'engine.linked': z.strictObject({ mode: z.enum(['tunnel', 'direct']), relinked: z.boolean() }),
    'engine.first_heartbeat': z.strictObject({ setup: z.enum([...SetupState.options, 'unreported']) }),
    /** The heartbeat's `setup` went from `pending` to `done` (onboarding@1). */
    'engine.setup_completed': none,
    'engine.removed': z.strictObject({ via: z.enum(['revoked', 'team-deleted']) }),
    /** One per invitation emailed; people already in the organization are added without one. */
    'invite.sent': z.strictObject({ role: orgRoleSchema, teams: z.int().min(0).max(100) }),
    'invite.accepted': z.strictObject({ as: z.enum(['new-account', 'existing-account']) }),
    /** A member opened a team's engine without access yet, so the dashboard signed them a ticket. */
    'access.requested': none,
    'access.approved': none,
    'access.declined': none,
} as const;

export type UsageEventName = keyof typeof USAGE_EVENT_PROPS;
export const USAGE_EVENT_NAMES = Object.keys(USAGE_EVENT_PROPS) as readonly UsageEventName[];

const subject = {
    orgId: orgIdSchema,
    userId: userIdSchema.nullable(),
    engineId: EngineId.nullable(),
};

function eventSchema<N extends UsageEventName>(name: N) {
    return z.strictObject({ event: z.literal(name), ...subject, props: USAGE_EVENT_PROPS[name] });
}

/** Parsed again before every write, so a caller that bypassed the types still cannot store free text. */
export const usageEventSchema = z.discriminatedUnion('event', [
    eventSchema('account.signed_up'),
    eventSchema('org.created'),
    eventSchema('engine.created'),
    eventSchema('engine.linked'),
    eventSchema('engine.first_heartbeat'),
    eventSchema('engine.setup_completed'),
    eventSchema('engine.removed'),
    eventSchema('invite.sent'),
    eventSchema('invite.accepted'),
    eventSchema('access.requested'),
    eventSchema('access.approved'),
    eventSchema('access.declined'),
]);
export type UsageEvent = z.infer<typeof usageEventSchema>;

/** An event as stored: when it happened, under a random ID, with its props as JSON. */
export interface UsageEventRow {
    readonly id: string;
    readonly occurredAt: number;
    readonly event: UsageEventName;
    readonly orgId: string;
    readonly userId: string | null;
    readonly engineId: string | null;
    readonly props: string;
}
