import { z } from 'zod';

import {
    AgentId,
    ChatId,
    Cursor,
    FileId,
    MemberId,
    MessageId,
    PageQuery,
    RunId,
    Slug,
    Timestamp,
    ToolCallId,
    TriggerId,
    pageOf,
} from '../common';
import { MAX_RUN_PREVIEW_LENGTH, MAX_RUN_TEXT_BYTES } from '../constants';
import { defineRoute } from '../route';
import { openEnum, toTolerant } from '../tolerant';
import { KNOWN_CAPABILITIES } from './capability';
import { CommitHash, FileName } from './files';

/** What started a run. Closed within `runs@1`. */
export const RUN_SOURCES = ['web', 'api', 'email', 'schedule', 'member', 'goal', 'webhook'] as const;
export const RunSource = z.enum(RUN_SOURCES);
export type RunSource = z.infer<typeof RunSource>;

export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

/** Statuses a run never leaves. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

/** A decimal amount as text, never a float, so money survives every JSON implementation exactly. */
export const Money = z.strictObject({
    amount: z.string().regex(/^\d{1,15}(?:\.\d{1,12})?$/),
    /** ISO 4217. */
    currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Money = z.infer<typeof Money>;

/** `null` fields are not known for this run (the runner did not report them). */
export const RunUsage = z.strictObject({
    inputTokens: z.int().min(0).nullable(),
    outputTokens: z.int().min(0).nullable(),
    durationMs: z.int().min(0).nullable(),
    cost: Money.nullable(),
});
export type RunUsage = z.infer<typeof RunUsage>;

/** A short, content-free description of why a run failed. */
export const RunError = z.strictObject({ code: Slug, summary: z.string().max(1024) });
export type RunError = z.infer<typeof RunError>;

export const PROGRESS_ITEM_STATUSES = ['pending', 'completed'] as const;

/** The agent's own progress card: what it is doing now and next, and its checklist. */
export const RunProgress = z.strictObject({
    title: z.string().max(256),
    now: z.string().max(1024).nullable(),
    next: z.string().max(1024).nullable(),
    items: z
        .array(
            z.strictObject({
                id: z.string().min(1).max(64),
                text: z.string().max(1024),
                status: z.enum(PROGRESS_ITEM_STATUSES),
            }),
        )
        .max(200),
});
export type RunProgress = z.infer<typeof RunProgress>;

/** One unit of agent work, whatever started it. */
export const Run = z.strictObject({
    id: RunId,
    agentId: AgentId,
    /**
     * The agent's name when the engine answered (since API 1.5), so a list across agents needs no lookup per row; the
     * name it had when it was deleted, `null` when the engine no longer knows it. Untrusted text: members type it.
     */
    agentName: z.string().min(1).max(256).nullable(),
    source: RunSource,
    status: RunStatus,
    chatId: ChatId.nullable(),
    /** The reply message this run produces, for chat runs. */
    messageId: MessageId.nullable(),
    triggerId: TriggerId.nullable(),
    /** The failed run this one retries. */
    retryOf: RunId.nullable(),
    /** `null` when no member started it (email, schedule, webhook). */
    createdBy: MemberId.nullable(),
    queuedAt: Timestamp,
    startedAt: Timestamp.nullable(),
    completedAt: Timestamp.nullable(),
    cancelRequestedAt: Timestamp.nullable(),
    attemptCount: z.int().min(0),
    /** e.g. the coding CLI that ran it. */
    runner: z.string().max(64).nullable(),
    model: z.string().max(128).nullable(),
    progress: RunProgress.nullable(),
    usage: RunUsage.nullable(),
    error: RunError.nullable(),
    /**
     * The text that started the run (since API 1.5): the user's message for a chat run, the subject of an inbound email,
     * a schedule's message, an API or member request. Whitespace runs collapsed to one space, cut to
     * `MAX_RUN_PREVIEW_LENGTH`; `null` when nothing textual started it. Untrusted text: render it as text only.
     */
    preview: z.string().max(MAX_RUN_PREVIEW_LENGTH).nullable(),
});
export type Run = z.infer<typeof Run>;
export const RunPage = pageOf(Run);

/** Plain text bounded by `MAX_RUN_TEXT_BYTES` of UTF-8; the engine truncates and sets the matching flag. */
export const RunText = z
    .string()
    .max(MAX_RUN_TEXT_BYTES)
    .refine((text) => new TextEncoder().encode(text).byteLength <= MAX_RUN_TEXT_BYTES, {
        message: `At most ${String(MAX_RUN_TEXT_BYTES)} bytes of UTF-8.`,
    });

export const TOOL_CALL_STATES = ['pending', 'partial', 'complete', 'error'] as const;

export const ToolCall = z.strictObject({
    id: ToolCallId,
    name: z.string().min(1).max(128),
    state: z.enum(TOOL_CALL_STATES),
    startedAt: Timestamp.nullable(),
    durationMs: z.int().min(0).nullable(),
    logs: RunText,
    logsTruncated: z.boolean(),
});
export type ToolCall = z.infer<typeof ToolCall>;

/** One commit an agent made in one of its git-backed projects. */
export const ProjectChange = z.strictObject({
    projectName: z.string().min(1).max(256),
    commitHash: CommitHash,
    changedFiles: z
        .array(
            z.strictObject({
                path: z.string().min(1).max(4096),
                insertions: z.int().min(0),
                deletions: z.int().min(0),
            }),
        )
        .max(10_000),
    diff: RunText,
    diffTruncated: z.boolean(),
});
export type ProjectChange = z.infer<typeof ProjectChange>;

export const RunOutputs = z
    .strictObject({
        messages: z.array(z.strictObject({ chatId: ChatId, messageId: MessageId })).max(1000),
        files: z.array(FileId).max(1000),
        /**
         * The name of each file in `files`, same length and order (since API 1.5), so outputs read without `files@1`.
         * The name the file had when the run produced it. Untrusted text.
         */
        fileNames: z.array(FileName).max(1000),
        projectChanges: z.array(ProjectChange).max(1000),
    })
    .refine((outputs) => outputs.fileNames.length === outputs.files.length, {
        message: 'fileNames must name each entry of files, in the same order.',
        path: ['fileNames'],
    });
export type RunOutputs = z.infer<typeof RunOutputs>;

export const RunDetail = Run.extend({
    toolCalls: z.array(ToolCall).max(1000),
    outputs: RunOutputs,
    /** What the run touched, for review: project names and external hostnames or URLs it read from. */
    report: z.strictObject({
        touchedProjects: z.array(z.string().min(1).max(256)).max(1000),
        externalSources: z.array(z.string().min(1).max(2048)).max(1000),
    }),
});
export type RunDetail = z.infer<typeof RunDetail>;

const STATUS_SET = new RegExp(`^(?:${RUN_STATUSES.join('|')})(?:,(?:${RUN_STATUSES.join('|')}))*$`);

export const RUN_SORTS = ['queuedAt', '-queuedAt'] as const;

export const RunListQuery = PageQuery.extend({
    agentId: AgentId.optional(),
    /** One status or a comma-separated set, e.g. `queued,running`. */
    status: z
        .string()
        .max(128)
        .regex(STATUS_SET)
        .transform((value) => [...new Set(value.split(','))])
        .pipe(z.array(RunStatus))
        .optional(),
    source: RunSource.optional(),
    triggerId: TriggerId.optional(),
    createdBy: MemberId.optional(),
    /** By `queuedAt`, inclusive. */
    from: Timestamp.optional(),
    /** By `queuedAt`, exclusive. */
    to: Timestamp.optional(),
    sort: z.enum(RUN_SORTS).default('-queuedAt'),
});

export const RunStatsQuery = z.strictObject({ agentId: AgentId.optional() });
export const RunStats = z.strictObject({
    running: z.int().min(0),
    queued: z.int().min(0),
    failedLast24h: z.int().min(0),
    oldestQueuedAt: Timestamp.nullable(),
    /**
     * The run that finished last, by `completedAt` (since API 1.5), so a client can tell a recent failure that nothing
     * has finished after from one a later run superseded. `null` when no run has finished.
     */
    lastFinished: z.strictObject({ status: z.enum(['completed', 'failed', 'cancelled']), at: Timestamp }).nullable(),
});
export type RunStats = z.infer<typeof RunStats>;

export const RunParams = z.strictObject({ runId: RunId });

/**
 * Runs as the client reads them: a `status` or `source` this contract does not know yet (a newer engine's) reads as
 * `unknown`, so the UI shows it as such instead of failing the whole list. Engines still answer with the closed enums.
 */
const openRunFields = { status: openEnum(RUN_STATUSES), source: openEnum(RUN_SOURCES) };
export const RunReader = toTolerant(Run.extend(openRunFields));
export type ReadRun = z.output<typeof RunReader>;
export const RunPageReader = z.object({ items: z.array(RunReader), nextCursor: Cursor.nullable() });
export const RunDetailReader = toTolerant(RunDetail.extend(openRunFields));
export type ReadRunDetail = z.output<typeof RunDetailReader>;

/** A hint to refetch; carries IDs and the new status, never content. */
export const RunChangedEvent = z.strictObject({
    type: z.literal('run.changed'),
    runId: RunId,
    agentId: AgentId,
    status: RunStatus,
});
/** `run.changed` as the client reads it: an unknown `status` reads as `unknown`, like `RunReader`. */
export const RunChangedEventReader = RunChangedEvent.extend({ status: openEnum(RUN_STATUSES) });

const capability = KNOWN_CAPABILITIES.runs;

export const RUN_ROUTES = {
    listRuns: defineRoute({
        id: 'listRuns',
        method: 'GET',
        path: '/runs',
        summary: 'List runs, newest first by default',
        permission: 'runs.read',
        capability,
        query: RunListQuery,
        responses: { 200: { kind: 'json', schema: RunPage, read: RunPageReader } },
    }),
    getRunStats: defineRoute({
        id: 'getRunStats',
        method: 'GET',
        path: '/runs/stats',
        summary: 'Count running, queued and recently failed runs',
        permission: 'runs.read',
        capability,
        query: RunStatsQuery,
        responses: { 200: { kind: 'json', schema: RunStats } },
    }),
    getRun: defineRoute({
        id: 'getRun',
        method: 'GET',
        path: '/runs/{runId}',
        summary: 'Get a run with its tool calls, outputs and report',
        permission: 'runs.read',
        capability,
        params: RunParams,
        responses: { 200: { kind: 'json', schema: RunDetail, read: RunDetailReader } },
    }),
    cancelRun: defineRoute({
        id: 'cancelRun',
        method: 'POST',
        path: '/runs/{runId}/cancel',
        summary: 'Ask a queued or running run to stop (idempotent)',
        description:
            'Sets `cancelRequestedAt`; the run reaches `cancelled` when the runner stops. A run that already finished answers 409 `run-finished`.',
        permission: 'runs.control',
        capability,
        params: RunParams,
        responses: { 202: { kind: 'json', schema: Run, read: RunReader } },
        problems: ['run-finished'],
    }),
    retryRun: defineRoute({
        id: 'retryRun',
        method: 'POST',
        path: '/runs/{runId}/retry',
        summary: 'Queue a new run that retries a failed one',
        description: 'Only a `failed` run can be retried; anything else answers 409 `run-not-retryable`.',
        permission: 'runs.control',
        capability,
        params: RunParams,
        responses: { 201: { kind: 'json', schema: Run, read: RunReader } },
        problems: ['run-not-retryable'],
    }),
} as const;
