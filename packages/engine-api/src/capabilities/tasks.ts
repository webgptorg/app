import { z } from 'zod';

import { AgentId, ChatId, Cursor, PageQuery, RunId, TaskId, TaskOccurrenceId, Timestamp, pageOf } from '../common';
import { defineRoute } from '../route';
import { openEnum, toTolerant } from '../tolerant';
import { KNOWN_CAPABILITIES } from './capability';

/**
 * The engine's readiness of a task, the same projection its list, dry-run, dashboard and scheduler share. Declared
 * outcomes (`done`, `failed`, `cancelled`, `retired`) and runtime observations (`active`, `awaiting-user`) are one
 * field, as the engine reports them. Closed within `tasks@1`; clients read an unknown state as `unknown`.
 */
export const TASK_STATES = [
    'active',
    'awaiting-user',
    'ready',
    'needs-assignment',
    'assigning',
    'needs-recovery',
    'failed',
    'incompatible',
    'blocked',
    'waiting-until',
    'waiting-dependency',
    'not-ready',
    'placeholder',
    'done',
    'cancelled',
    'retired',
] as const;
export const TaskState = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskState>;

/**
 * Who owns the definition: `ordinary` is source-backed (a project Book or legacy Markdown section); `engine` is an
 * engine-owned system task such as the self-update, with no project Book.
 */
export const TASK_KINDS = ['ordinary', 'engine'] as const;
export const TaskKind = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKind>;

/** The effective `TASK PURPOSE`, project-relative; independent of `kind` and of core provenance. Presentation only. */
export const TASK_PURPOSES = ['content', 'system'] as const;
export const TaskPurpose = z.enum(TASK_PURPOSES);

/**
 * Where the task came from (`TASK ORIGIN`): `user` explicit work, `chat` created in a conversation, `task` derived from
 * another task (Router, Teacher, Fixer), `goal` goal discovery, `engine` engine-owned work, `conversion` migrated.
 */
export const TASK_ORIGIN_KINDS = ['user', 'chat', 'task', 'goal', 'engine', 'conversion'] as const;

/**
 * What the engine would accept for this task through chat-driven task control. Reported, never assumed: an engine that
 * reports none (the default) still takes every change through a conversation with Chatter.
 */
export const TASK_ACTIONS = ['amend', 'accept', 'cancel', 'retire', 'reopen', 'notify'] as const;

/** The kind of one condition the engine evaluates before the task may start. */
export const TASK_CONDITION_KINDS = ['not-before', 'dependency', 'answer', 'resource', 'schedule', 'other'] as const;

/** A prerequisite's standing: only a successful `met` dependency lets the dependant run. */
export const TASK_DEPENDENCY_STATES = ['met', 'pending', 'failed', 'missing', 'cycle'] as const;

/** Untrusted text from Books and agents: render it as text only. */
const TaskName = z.string().min(1).max(512);
const TaskText = z.string().max(2048);

/** Another task by its transport ID and Book name; `taskId` is `null` when the name does not resolve to a task. */
export const TaskRef = z.strictObject({ taskId: TaskId.nullable(), name: TaskName });
export type TaskRef = z.infer<typeof TaskRef>;

export const TaskDependency = TaskRef.extend({ state: z.enum(TASK_DEPENDENCY_STATES) });
export type TaskDependency = z.infer<typeof TaskDependency>;

export const TaskCondition = z.strictObject({
    kind: z.enum(TASK_CONDITION_KINDS),
    met: z.boolean(),
    text: TaskText,
});
export type TaskCondition = z.infer<typeof TaskCondition>;

export const TaskPriority = z.strictObject({
    /** Effective rank, higher first; `0` when the Book gives none. */
    rank: z.number().min(0).max(1_000_000),
    /** The Book's wording when it was not a plain number, e.g. "urgent". */
    text: z.string().max(256).nullable(),
});
export type TaskPriority = z.infer<typeof TaskPriority>;

/** `TASK REPEAT`: a fixed interval as written and in seconds. */
export const TaskRepeat = z.strictObject({
    text: z.string().min(1).max(128),
    intervalSeconds: z.int().min(1),
});

export const TaskProgress = z.strictObject({
    completed: z.int().min(0),
    total: z.int().min(0),
    /** The executing agent's one-line "now" for the current occurrence. */
    summary: z.string().max(1024).nullable(),
});
export type TaskProgress = z.infer<typeof TaskProgress>;

export const TaskOrigin = z.strictObject({
    kind: z.enum(TASK_ORIGIN_KINDS),
    /** The source conversation, `TASK ORIGIN Chat {…}`: the default place to discuss the task. */
    chatId: ChatId.nullable(),
    /** The task this one was derived from. */
    taskId: TaskId.nullable(),
    text: z.string().max(512).nullable(),
});
export type TaskOrigin = z.infer<typeof TaskOrigin>;

/**
 * One task definition. Identity is the engine's: an ordinary task is its normalized Book name, so a rename is a new
 * task; `id` is the engine's opaque transport form of that identity (or of an engine-owned definition), never parsed.
 */
export const Task = z.strictObject({
    id: TaskId,
    name: TaskName,
    kind: TaskKind,
    purpose: TaskPurpose.nullable(),
    /** Descriptive core provenance: only core agents perform the work. Not an execution kind. */
    core: z.boolean(),
    /** The responsible agent (`TASK AGENT` or Router's recorded choice); `null` while unassigned or engine-owned. */
    agentId: AgentId.nullable(),
    agentName: z.string().min(1).max(256).nullable(),
    /** An engine-owned task's actual implementation, shown instead of an agent. */
    executor: z.string().max(128).nullable(),
    priority: TaskPriority,
    state: TaskState,
    /** The engine's explanation of `state`. */
    stateReason: TaskText.nullable(),
    /** What would move a blocked or waiting task on. */
    next: TaskText.nullable(),
    conditions: z.array(TaskCondition).max(100),
    repeat: TaskRepeat.nullable(),
    /** `TASK AFTER`: the inclusive earliest start. */
    notBefore: Timestamp.nullable(),
    /** `TASK DUE DATE`: a deadline, never permission to start. */
    dueAt: Timestamp.nullable(),
    /** The next execution opportunity: earliest start or next occurrence. */
    nextAt: Timestamp.nullable(),
    progress: TaskProgress.nullable(),
    /** `TASK PARENT`: grouping only, no order. */
    parent: TaskRef.nullable(),
    /** `TASK DEPENDS ON`: prerequisites in source order. */
    dependsOn: z.array(TaskDependency).max(200),
    origin: TaskOrigin.nullable(),
    /** Completed work cycles (`TASK DONE` stamps, every occurrence of a recurring task included). */
    doneCount: z.int().min(0),
    lastDoneAt: Timestamp.nullable(),
    /** Reopened (`TASK REOPEN`) and not completed since. */
    reopened: z.boolean(),
    /** Project-relative path of the Book; `null` for an engine-owned task. */
    sourcePath: z.string().min(1).max(1024).nullable(),
    allowedActions: z.array(z.enum(TASK_ACTIONS)).max(TASK_ACTIONS.length),
    updatedAt: Timestamp,
});
export type Task = z.infer<typeof Task>;
export const TaskPage = pageOf(Task);

export const TASK_LINK_DIRECTIONS = ['outgoing', 'incoming'] as const;

/** A `LINK` or Book reference edge; `id` is `null` when the name does not resolve. */
export const TaskLinkTarget = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('chat'), chatId: ChatId.nullable(), name: TaskName }),
    z.strictObject({ type: z.literal('agent'), agentId: AgentId.nullable(), name: TaskName }),
    z.strictObject({ type: z.literal('task'), taskId: TaskId.nullable(), name: TaskName }),
]);
export type TaskLinkTarget = z.infer<typeof TaskLinkTarget>;

/**
 * One edge of the directed link graph around the task: `outgoing` is written in this task's Book, `incoming` in the
 * other one's. Links never schedule, grant authority or add participants.
 */
export const TaskLink = z.strictObject({ direction: z.enum(TASK_LINK_DIRECTIONS), target: TaskLinkTarget });
export type TaskLink = z.infer<typeof TaskLink>;

export const TaskDetail = Task.extend({
    /** Tasks whose `TASK PARENT` is this one. */
    children: z.array(TaskRef.extend({ state: TaskState })).max(1000),
    /** Tasks whose `TASK DEPENDS ON` names this one. */
    blocks: z.array(TaskRef.extend({ state: TaskState })).max(1000),
    links: z.array(TaskLink).max(1000),
    /** `TASK NOTE` texts, oldest first. */
    notes: z.array(TaskText).max(200),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/** Why an occurrence exists: the first cycle, a recurring slot, a coalesced catch-up, a reopening, or a retry. */
export const OCCURRENCE_REASONS = ['first', 'repeat', 'catch-up', 'reopen', 'retry'] as const;
export const OCCURRENCE_STATES = [
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
] as const;
export const OccurrenceState = z.enum(OCCURRENCE_STATES);

/**
 * One occurrence of a task: a work cycle, a recurring run or a retry, with its own outcome. Timestamps are not identity;
 * `id` is. Several runs (attempts, sessions) may belong to one occurrence.
 */
export const TaskOccurrence = z.strictObject({
    id: TaskOccurrenceId,
    taskId: TaskId,
    /** 1-based position among the task's occurrences. */
    sequence: z.int().min(1),
    /** 1-based work cycle; a `TASK REOPEN` starts the next one. */
    cycle: z.int().min(1),
    reason: z.enum(OCCURRENCE_REASONS),
    /** The failed occurrence this one retries. */
    retryOf: TaskOccurrenceId.nullable(),
    state: OccurrenceState,
    scheduledFor: Timestamp.nullable(),
    startedAt: Timestamp.nullable(),
    endedAt: Timestamp.nullable(),
    /** The verified result or the cause of failure, in a line. */
    summary: z.string().max(1024).nullable(),
    runIds: z.array(RunId).max(100),
});
export type TaskOccurrence = z.infer<typeof TaskOccurrence>;
export const TaskOccurrencePage = pageOf(TaskOccurrence);

/** The task list is never longer than this many characters of comma-separated states. */
const STATE_SET_MAX = 512;
const STATE_SET = new RegExp(`^(?:${TASK_STATES.join('|')})(?:,(?:${TASK_STATES.join('|')}))*$`);

/** In the engine's default order: current decisions first, then upcoming, recent, distant and old work. */
export const TaskListQuery = PageQuery.extend({
    /** One state or a comma-separated set. */
    state: z
        .string()
        .max(STATE_SET_MAX)
        .regex(STATE_SET)
        .transform((value) => [...new Set(value.split(','))])
        .pipe(z.array(TaskState))
        .optional(),
    kind: TaskKind.optional(),
    agentId: AgentId.optional(),
    parentId: TaskId.optional(),
    /** Case-insensitive substring of the name. */
    q: z.string().trim().min(1).max(256).optional(),
});

export const TaskParams = z.strictObject({ taskId: TaskId });
export const TaskOccurrenceListQuery = PageQuery;

const openTaskFields = {
    state: openEnum(TASK_STATES),
    kind: openEnum(TASK_KINDS),
    purpose: openEnum(TASK_PURPOSES).nullable(),
    allowedActions: z
        .array(z.string())
        .transform((actions) =>
            actions.filter((action): action is (typeof TASK_ACTIONS)[number] =>
                (TASK_ACTIONS as readonly string[]).includes(action),
            ),
        ),
    conditions: z.array(TaskCondition.extend({ kind: openEnum(TASK_CONDITION_KINDS) })),
    dependsOn: z.array(TaskDependency.extend({ state: openEnum(TASK_DEPENDENCY_STATES) })),
    origin: TaskOrigin.extend({ kind: openEnum(TASK_ORIGIN_KINDS) }).nullable(),
};
const TaskRefWithOpenState = TaskRef.extend({ state: openEnum(TASK_STATES) });
/** A link whose target type this contract does not know is dropped, not a failure of the whole task. */
const linkReader = z.array(z.unknown()).transform((links) =>
    links.flatMap((link) => {
        const parsed = toTolerant(TaskLink).safeParse(link);
        return parsed.success ? [parsed.data] : [];
    }),
);

/**
 * Tasks as the client reads them: unknown states, kinds, condition kinds and origins read as `unknown`, unknown
 * actions and link types are dropped. Engines still answer with the closed enums.
 */
export const TaskReader = toTolerant(Task.extend(openTaskFields));
export type ReadTask = z.output<typeof TaskReader>;
export const TaskPageReader = z.object({ items: z.array(TaskReader), nextCursor: Cursor.nullable() });
export const TaskDetailReader = toTolerant(
    TaskDetail.extend({
        ...openTaskFields,
        children: z.array(TaskRefWithOpenState),
        blocks: z.array(TaskRefWithOpenState),
        links: linkReader,
    }),
);
export type ReadTaskDetail = z.output<typeof TaskDetailReader>;
const openOccurrenceFields = { state: openEnum(OCCURRENCE_STATES), reason: openEnum(OCCURRENCE_REASONS) };
export const TaskOccurrenceReader = toTolerant(TaskOccurrence.extend(openOccurrenceFields));
export type ReadTaskOccurrence = z.output<typeof TaskOccurrenceReader>;
export const TaskOccurrencePageReader = z.object({
    items: z.array(TaskOccurrenceReader),
    nextCursor: Cursor.nullable(),
});

/** A hint to refetch; carries the ID and the new state, never content. */
export const TaskChangedEvent = z.strictObject({ type: z.literal('task.changed'), taskId: TaskId, state: TaskState });
export const TaskChangedEventReader = TaskChangedEvent.extend({ state: openEnum(TASK_STATES) });

const capability = KNOWN_CAPABILITIES.tasks;

/** Read-only: work changes through a conversation with Chatter, never through a task route. */
export const TASK_ROUTES = {
    listTasks: defineRoute({
        id: 'listTasks',
        method: 'GET',
        path: '/tasks',
        summary: "List every task definition, ordinary and engine-owned, in the engine's default order",
        permission: 'tasks.read',
        capability,
        query: TaskListQuery,
        responses: { 200: { kind: 'json', schema: TaskPage, read: TaskPageReader } },
    }),
    getTask: defineRoute({
        id: 'getTask',
        method: 'GET',
        path: '/tasks/{taskId}',
        summary: 'Get a task with its children, dependants, links and notes',
        permission: 'tasks.read',
        capability,
        params: TaskParams,
        responses: { 200: { kind: 'json', schema: TaskDetail, read: TaskDetailReader } },
    }),
    listTaskOccurrences: defineRoute({
        id: 'listTaskOccurrences',
        method: 'GET',
        path: '/tasks/{taskId}/occurrences',
        summary: "List a task's occurrences, newest first",
        permission: 'tasks.read',
        capability,
        params: TaskParams,
        query: TaskOccurrenceListQuery,
        responses: { 200: { kind: 'json', schema: TaskOccurrencePage, read: TaskOccurrencePageReader } },
    }),
} as const;
