import { z } from 'zod';

import { AgentId, Cursor, MemberId, PageQuery, RunId, Timestamp, TriggerFireId, TriggerId, pageOf } from '../common';
import { MAX_MESSAGE_LENGTH } from '../constants';
import { defineRoute } from '../route';
import { openEnum, toTolerant } from '../tolerant';
import { KNOWN_CAPABILITIES } from './capability';
import { RunError } from './runs';

export const TRIGGER_KINDS = ['email', 'schedule', 'webhook'] as const;
export const TriggerKind = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof TriggerKind>;

/** A trigger with a future `startsAt` is `active` but has not fired yet. */
export const TRIGGER_LIFECYCLES = ['active', 'paused', 'ended', 'failed'] as const;
export const TriggerLifecycle = z.enum(TRIGGER_LIFECYCLES);
export type TriggerLifecycle = z.infer<typeof TriggerLifecycle>;

export const TRIGGER_ENDED_REASONS = ['completed', 'cancelled', 'max-runs'] as const;

/** 60 seconds to 366 days. */
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 366 * 24 * 3600;

/**
 * When a schedule fires. A cron `expression` has five fields (minute, hour, day of month, month, day of week) and is
 * evaluated in the IANA `timeZone`; the engine answers 422 `invalid-schedule` for an expression or zone it cannot use.
 */
export const RECURRENCE_KINDS = ['once', 'interval', 'cron'] as const;

export const Recurrence = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('once'), at: Timestamp }),
    z.strictObject({
        kind: z.literal('interval'),
        everySeconds: z.int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS),
    }),
    z.strictObject({
        kind: z.literal('cron'),
        expression: z.string().min(9).max(128),
        timeZone: z.string().min(1).max(64),
    }),
]);
export type Recurrence = z.infer<typeof Recurrence>;

export const ScheduleMessage = z.string().min(1).max(MAX_MESSAGE_LENGTH);

export const ScheduleConfig = z.strictObject({
    recurrence: Recurrence,
    startsAt: Timestamp,
    endsAt: Timestamp.nullable(),
    maxRunCount: z.int().min(1).nullable(),
    runCount: z.int().min(0),
    /** Sent to the agent as the run's prompt each time the schedule fires. */
    message: ScheduleMessage,
});
export type ScheduleConfig = z.infer<typeof ScheduleConfig>;

const triggerBase = {
    id: TriggerId,
    agentId: AgentId,
    /**
     * The agent's name when the engine answered (since API 1.7), so a list across agents needs no lookup per row; the
     * name it had when it was deleted, `null` when the engine no longer knows it. Untrusted text: members type it.
     */
    agentName: z.string().min(1).max(256).nullable(),
    name: z.string().trim().min(1).max(128),
    lifecycle: TriggerLifecycle,
    /** Set exactly when `lifecycle` is `ended`. */
    endedReason: z.enum(TRIGGER_ENDED_REASONS).nullable(),
    lastFiredAt: Timestamp.nullable(),
    nextFireAt: Timestamp.nullable(),
    createdBy: MemberId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
};

export const Trigger = z.discriminatedUnion('kind', [
    /** Each email to the engine-assigned `address` starts an `email`-source run. */
    z.strictObject({
        ...triggerBase,
        kind: z.literal('email'),
        config: z.strictObject({ address: z.email().max(254) }),
    }),
    z.strictObject({ ...triggerBase, kind: z.literal('schedule'), config: ScheduleConfig }),
    /** Shape only (draft): engines do not create webhook triggers in `triggers@1`. */
    z.strictObject({
        ...triggerBase,
        kind: z.literal('webhook'),
        config: z.strictObject({ path: z.string().regex(/^\/[A-Za-z0-9/_-]{1,255}$/) }),
    }),
]);
export type Trigger = z.infer<typeof Trigger>;
export const TriggerPage = pageOf(Trigger);

export const TRIGGER_FIRE_OUTCOMES = ['started', 'skipped', 'failed'] as const;

export const TriggerFire = z.strictObject({
    id: TriggerFireId,
    at: Timestamp,
    outcome: z.enum(TRIGGER_FIRE_OUTCOMES),
    /** The run it started; `null` unless `outcome` is `started`. */
    runId: RunId.nullable(),
    error: RunError.nullable(),
});
export type TriggerFire = z.infer<typeof TriggerFire>;
export const TriggerFirePage = pageOf(TriggerFire);

/**
 * A kind, lifecycle or recurrence this contract does not know yet (a newer engine's) as the client reads it: `unknown`,
 * with the value the engine sent kept for display.
 */
const RawValue = z.string().min(1).max(64);

const readBase = {
    ...triggerBase,
    lifecycle: z.enum([...TRIGGER_LIFECYCLES, 'unknown']),
    /** The lifecycle exactly as the engine sent it; differs from `lifecycle` only when that reads `unknown`. */
    rawLifecycle: RawValue,
    endedReason: openEnum(TRIGGER_ENDED_REASONS).nullable(),
};

export const UnknownRecurrence = z.strictObject({ kind: z.literal('unknown'), rawKind: RawValue });

const ReadTrigger = z.discriminatedUnion('kind', [
    z.strictObject({ ...readBase, kind: z.literal('email'), config: z.strictObject({ address: z.email().max(254) }) }),
    z.strictObject({
        ...readBase,
        kind: z.literal('schedule'),
        config: ScheduleConfig.extend({
            recurrence: z.discriminatedUnion('kind', [...Recurrence.options, UnknownRecurrence]),
        }),
    }),
    z.strictObject({
        ...readBase,
        kind: z.literal('webhook'),
        config: z.strictObject({ path: z.string().regex(/^\/[A-Za-z0-9/_-]{1,255}$/) }),
    }),
    /** A kind this client does not know: everything but its kind-specific `config`. */
    z.strictObject({ ...readBase, kind: z.literal('unknown'), rawKind: RawValue }),
]);
export type ReadTrigger = z.output<typeof ReadTrigger>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf(values: readonly string[], value: unknown): value is string {
    return typeof value === 'string' && values.includes(value);
}

/** Rewrites the open values into the reader's shape; the tolerant parse that follows checks everything else. */
function openTrigger(raw: unknown): unknown {
    if (!isRecord(raw)) return raw;
    const read: Record<string, unknown> = { ...raw };
    const { lifecycle, kind, config } = raw;
    if (typeof lifecycle === 'string') {
        read['rawLifecycle'] = lifecycle;
        read['lifecycle'] = isOneOf(TRIGGER_LIFECYCLES, lifecycle) ? lifecycle : 'unknown';
    }
    if (typeof kind === 'string' && !isOneOf(TRIGGER_KINDS, kind)) {
        delete read['config'];
        read['kind'] = 'unknown';
        read['rawKind'] = kind;
    } else if (kind === 'schedule' && isRecord(config) && isRecord(config['recurrence'])) {
        const recurrenceKind = config['recurrence']['kind'];
        if (typeof recurrenceKind === 'string' && !isOneOf(RECURRENCE_KINDS, recurrenceKind)) {
            read['config'] = { ...config, recurrence: { kind: 'unknown', rawKind: recurrenceKind } };
        }
    }
    return read;
}

/**
 * Triggers as the client reads them (since API 1.7): an unknown `kind` reads as `{ kind: 'unknown', rawKind }` without
 * `config`, an unknown recurrence as `{ kind: 'unknown', rawKind }`, an unknown `lifecycle` as `unknown` next to
 * `rawLifecycle`, an unknown `endedReason` as `unknown`. Engines still answer with the closed `Trigger`.
 */
export const TriggerReader = z.preprocess(openTrigger, toTolerant(ReadTrigger));
export const TriggerPageReader = z.object({ items: z.array(TriggerReader), nextCursor: Cursor.nullable() });

/** A fire as the client reads it: an unknown `outcome` reads as `unknown`. */
export const TriggerFireReader = toTolerant(TriggerFire.extend({ outcome: openEnum(TRIGGER_FIRE_OUTCOMES) }));
export type ReadTriggerFire = z.output<typeof TriggerFireReader>;
export const TriggerFirePageReader = z.object({ items: z.array(TriggerFireReader), nextCursor: Cursor.nullable() });

export const TriggerListQuery = PageQuery.extend({
    agentId: AgentId.optional(),
    kind: TriggerKind.optional(),
    lifecycle: TriggerLifecycle.optional(),
});

export const TriggerParams = z.strictObject({ triggerId: TriggerId });

export const TriggerStatsQuery = z.strictObject({ agentId: AgentId.optional() });
/** Triggers counted by lifecycle (since API 1.7), and the soonest `nextFireAt` among the active ones. */
export const TriggerStats = z.strictObject({
    active: z.int().min(0),
    paused: z.int().min(0),
    failed: z.int().min(0),
    ended: z.int().min(0),
    nextFireAt: Timestamp.nullable(),
});
export type TriggerStats = z.infer<typeof TriggerStats>;

/** Webhook triggers cannot be created in `triggers@1`; email triggers get their address from the engine. */
export const CreateTriggerBody = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('schedule'),
        agentId: AgentId,
        name: triggerBase.name,
        recurrence: Recurrence,
        /** Defaults to now. */
        startsAt: Timestamp.optional(),
        endsAt: Timestamp.nullable().optional(),
        maxRunCount: z.int().min(1).nullable().optional(),
        message: ScheduleMessage,
    }),
    z.strictObject({ kind: z.literal('email'), agentId: AgentId, name: triggerBase.name }),
]);

/** Schedule fields apply only to schedule triggers; on another kind they are a validation error. */
export const UpdateTriggerBody = z.strictObject({
    name: triggerBase.name.optional(),
    recurrence: Recurrence.optional(),
    startsAt: Timestamp.optional(),
    endsAt: Timestamp.nullable().optional(),
    maxRunCount: z.int().min(1).nullable().optional(),
    message: ScheduleMessage.optional(),
});

export const TriggerChangedEvent = z.strictObject({
    type: z.literal('trigger.changed'),
    triggerId: TriggerId,
    agentId: AgentId,
});

const capability = KNOWN_CAPABILITIES.triggers;
const one = { kind: 'json', schema: Trigger, read: TriggerReader } as const;

export const TRIGGER_ROUTES = {
    listTriggers: defineRoute({
        id: 'listTriggers',
        method: 'GET',
        path: '/triggers',
        summary: 'List triggers, newest first',
        permission: 'triggers.read',
        capability,
        query: TriggerListQuery,
        responses: { 200: { kind: 'json', schema: TriggerPage, read: TriggerPageReader } },
    }),
    getTriggerStats: defineRoute({
        id: 'getTriggerStats',
        method: 'GET',
        path: '/triggers/stats',
        summary: 'Count triggers by lifecycle, with the soonest next fire',
        permission: 'triggers.read',
        capability,
        query: TriggerStatsQuery,
        responses: { 200: { kind: 'json', schema: TriggerStats } },
    }),
    createTrigger: defineRoute({
        id: 'createTrigger',
        method: 'POST',
        path: '/triggers',
        summary: 'Create a schedule or an inbound email address for an agent',
        permission: 'triggers.manage',
        capability,
        body: { kind: 'json', schema: CreateTriggerBody },
        responses: { 201: one },
        problems: ['invalid-schedule', 'agent-deleted'],
    }),
    getTrigger: defineRoute({
        id: 'getTrigger',
        method: 'GET',
        path: '/triggers/{triggerId}',
        summary: 'Get a trigger',
        permission: 'triggers.read',
        capability,
        params: TriggerParams,
        responses: { 200: one },
    }),
    updateTrigger: defineRoute({
        id: 'updateTrigger',
        method: 'PATCH',
        path: '/triggers/{triggerId}',
        summary: "Rename a trigger or change a schedule's timing and message",
        permission: 'triggers.manage',
        capability,
        params: TriggerParams,
        body: { kind: 'json', schema: UpdateTriggerBody },
        responses: { 200: one },
        problems: ['invalid-schedule', 'trigger-ended'],
    }),
    deleteTrigger: defineRoute({
        id: 'deleteTrigger',
        method: 'DELETE',
        path: '/triggers/{triggerId}',
        summary: 'Delete a trigger; runs it started are kept',
        permission: 'triggers.manage',
        capability,
        params: TriggerParams,
        responses: { 204: { kind: 'empty' } },
    }),
    pauseTrigger: defineRoute({
        id: 'pauseTrigger',
        method: 'POST',
        path: '/triggers/{triggerId}/pause',
        summary: 'Pause a trigger (idempotent)',
        permission: 'triggers.manage',
        capability,
        params: TriggerParams,
        responses: { 200: one },
        problems: ['trigger-ended'],
    }),
    resumeTrigger: defineRoute({
        id: 'resumeTrigger',
        method: 'POST',
        path: '/triggers/{triggerId}/resume',
        summary: 'Resume a paused or failed trigger (idempotent); an ended one answers 409 `trigger-ended`',
        permission: 'triggers.manage',
        capability,
        params: TriggerParams,
        responses: { 200: one },
        problems: ['trigger-ended'],
    }),
    listTriggerFires: defineRoute({
        id: 'listTriggerFires',
        method: 'GET',
        path: '/triggers/{triggerId}/fires',
        summary: "List a trigger's fires, newest first, each linked to the run it started",
        permission: 'triggers.read',
        capability,
        params: TriggerParams,
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: TriggerFirePage, read: TriggerFirePageReader } },
    }),
} as const;
