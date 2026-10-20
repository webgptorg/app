import { z } from 'zod';

import {
    ActivityId,
    AgentId,
    Cursor,
    FileId,
    Hostname,
    IntegrationId,
    MemberId,
    PageQuery,
    RunId,
    SemVer,
    Timestamp,
    TriggerId,
    pageOf,
} from '../common';
import { Role } from '../permissions';
import type { Permission } from '../permissions';
import { defineRoute } from '../route';
import { toTolerant } from '../tolerant';
import { FileName, FilePurpose } from './files';
import { RunError, RunSource, RunUsage } from './runs';

export const ActivityActor = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('member'), memberId: MemberId }),
    z.strictObject({ kind: z.literal('system') }),
    z.strictObject({ kind: z.literal('trigger'), triggerId: TriggerId }),
]);
export type ActivityActor = z.infer<typeof ActivityActor>;

/** `<area>.<event>`, e.g. `run.completed`; the area decides which read permission shows it. */
export const ActivityKind = z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);

/**
 * What every activity item has, whatever its kind and version. Not strict, because it is read out of items whose other
 * fields this client may not know; an item without a valid base is dropped.
 */
export const ActivityBase = z.object({
    kind: ActivityKind,
    v: z.int().min(1),
    id: ActivityId,
    at: Timestamp,
    agentId: AgentId.nullable(),
    actor: toTolerant(ActivityActor),
});
export type ActivityBase = z.infer<typeof ActivityBase>;

const baseShape = { id: ActivityId, at: Timestamp, agentId: AgentId.nullable(), actor: ActivityActor };
const summaryName = z.string().max(256);

function v1<Kind extends string, Shape extends z.ZodRawShape>(kind: Kind, payload: Shape) {
    return z.strictObject({ kind: z.literal(kind), v: z.literal(1), ...baseShape, ...payload });
}

const runRef = { runId: RunId, source: RunSource };
const fileRef = { fileId: FileId, name: FileName };
const triggerRef = { triggerId: TriggerId, name: summaryName };
const integrationRef = { integrationId: IntegrationId, name: summaryName };
const memberRef = { memberId: MemberId, displayName: summaryName };

/**
 * Every activity kind this contract knows, at version 1. Items carry IDs and short names, never message or file
 * content. A new kind is additive; a changed payload is a new `v` of the same kind.
 */
export const Activity = z.discriminatedUnion('kind', [
    v1('run.queued', runRef),
    v1('run.started', runRef),
    v1('run.completed', { ...runRef, usage: RunUsage.nullable() }),
    v1('run.failed', { ...runRef, error: RunError.nullable() }),
    v1('run.cancelled', runRef),
    v1('file.created', { ...fileRef, purpose: FilePurpose }),
    v1('file.deleted', fileRef),
    v1('file.scan-failed', fileRef),
    v1('trigger.fired', { ...triggerRef, runId: RunId.nullable() }),
    v1('trigger.failed', { ...triggerRef, error: RunError }),
    v1('trigger.paused', triggerRef),
    v1('trigger.resumed', triggerRef),
    v1('integration.connected', integrationRef),
    v1('integration.error', { ...integrationRef, statusDetail: z.string().max(1024).nullable() }),
    v1('integration.used', { ...integrationRef, toolName: z.string().min(1).max(128), runId: RunId.nullable() }),
    v1('member.joined', memberRef),
    v1('member.role-changed', { ...memberRef, role: Role, previousRole: Role }),
    v1('member.removed', memberRef),
    v1('engine.update-available', { version: SemVer }),
    v1('engine.updated', { fromVersion: SemVer, toVersion: SemVer }),
    v1('engine.relay-disconnected', { relay: Hostname }),
]);
export type Activity = z.infer<typeof Activity>;
export type ActivityKindName = Activity['kind'];

const KNOWN_ACTIVITY = new Map<string, { readonly version: number; readonly schema: z.ZodType<Activity> }>(
    Activity.options.map((option) => [option.shape.kind.value, { version: 1, schema: toTolerant(option) }]),
);

export const ACTIVITY_KINDS = [...KNOWN_ACTIVITY.keys()] as readonly ActivityKindName[];

/** The read permission that shows each area; areas not listed are shown to nobody (deny by default). */
export const ACTIVITY_PERMISSIONS = {
    run: 'runs.read',
    file: 'files.read',
    trigger: 'triggers.read',
    integration: 'integrations.read',
    member: 'members.read',
    engine: 'security.read',
} as const satisfies Readonly<Record<string, Permission>>;

export function activityPermission(kind: string): Permission | null {
    const area = kind.split('.')[0] ?? '';
    return Object.hasOwn(ACTIVITY_PERMISSIONS, area)
        ? ACTIVITY_PERMISSIONS[area as keyof typeof ACTIVITY_PERMISSIONS]
        : null;
}

/** Where an item failed, without the values (they may be content). */
export interface ActivityIssue {
    readonly path: string;
    readonly code: string;
}

/** One activity as a client reads it; render `unknown` and `invalid` with a generic card, never as an error. */
export type ActivityItem =
    | { readonly kind: 'known'; readonly activity: Activity }
    /** A kind, or a version of a kind, this client does not know. */
    | { readonly kind: 'unknown'; readonly base: ActivityBase; readonly raw: unknown }
    /** A known kind and version whose payload breaks its schema; conformance fails such an engine. */
    | { readonly kind: 'invalid'; readonly base: ActivityBase; readonly issues: readonly ActivityIssue[] };

/** `dropped` when not even `ActivityBase` parses: such an item is left out and counted. */
export type ParsedActivity = ActivityItem | { readonly kind: 'dropped'; readonly issues: readonly ActivityIssue[] };

function issuesOf(error: z.ZodError): ActivityIssue[] {
    return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code }));
}

/**
 * Reads one activity item of any shape and never throws. Unknown fields of a known kind are stripped (ADR 0010 §3), so
 * an engine may add optional fields within a version.
 */
export function parseActivity(input: unknown): ParsedActivity {
    const base = ActivityBase.safeParse(input);
    if (!base.success) return { kind: 'dropped', issues: issuesOf(base.error) };
    const known = KNOWN_ACTIVITY.get(base.data.kind);
    if (known?.version !== base.data.v) return { kind: 'unknown', base: base.data, raw: input };
    const activity = known.schema.safeParse(input);
    return activity.success
        ? { kind: 'known', activity: activity.data }
        : { kind: 'invalid', base: base.data, issues: issuesOf(activity.error) };
}

/** A page as the client reads it: one bad item never fails the page; items without a valid base are counted. */
export interface ActivityPageRead {
    readonly items: readonly ActivityItem[];
    readonly nextCursor: string | null;
    readonly dropped: number;
}

export const ActivityPageReader = z
    .object({ items: z.array(z.unknown()), nextCursor: Cursor.nullable() })
    .transform(({ items, nextCursor }): ActivityPageRead => {
        const read: ActivityItem[] = [];
        for (const item of items) {
            const parsed = parseActivity(item);
            if (parsed.kind !== 'dropped') read.push(parsed);
        }
        return { items: read, nextCursor, dropped: items.length - read.length };
    });

export const ActivityPage = pageOf(Activity);

export const ActivityListQuery = PageQuery.extend({
    agentId: AgentId.optional(),
    /** An exact kind (`run.failed`) or an area prefix ending in a dot (`run.`). */
    kind: z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.?$/)
        .optional(),
    runId: RunId.optional(),
    triggerId: TriggerId.optional(),
    integrationId: IntegrationId.optional(),
    /** Inclusive. */
    from: Timestamp.optional(),
    /** Exclusive. */
    to: Timestamp.optional(),
});

export const ActivityEvent = z.strictObject({ type: z.literal('activity'), activity: Activity });

export const ACTIVITY_ROUTES = {
    listActivity: defineRoute({
        id: 'listActivity',
        method: 'GET',
        path: '/activity',
        summary: 'List activity, newest first',
        description:
            "Each item is shown only with its area's read permission (`ACTIVITY_PERMISSIONS`) and only for agents the member may read; other items are left out, not reported.",
        permission: 'agents.read',
        query: ActivityListQuery,
        responses: { 200: { kind: 'json', schema: ActivityPage, read: ActivityPageReader } },
    }),
} as const;
