import { ChatTask, MAX_CHAT_TASKS } from '../chats';
import type { ChatTaskState } from '../chats';
import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import type { EngineContext } from './kit';
import { advertises } from './kit';
import type { ChatRecord } from './threads';
import { link } from './threads';

/** A task as a seed or a lever links it; everything but the name has the engine's defaults. */
export interface ChatTaskInput {
    readonly name: string;
    /** Resolved by name among the engine's tasks (`tasks@1`) when not given. */
    readonly taskId?: string | null;
    readonly state?: ChatTaskState;
    readonly detail?: string | null;
    readonly agentId?: string | null;
    readonly commit?: string | null;
    readonly reopened?: boolean;
    readonly startedAt?: string | null;
    readonly endedAt?: string | null;
}

export type ChatTaskChange = Pick<ChatTaskInput, 'state' | 'detail' | 'agentId' | 'commit'>;

const FINISHED: ReadonlySet<ChatTaskState> = new Set(['completed', 'failed', 'cancelled', 'retired']);
/** Finishing that a reopen undoes; a failed task that runs again is a retry, not a reopen. */
const CLOSED: ReadonlySet<ChatTaskState> = new Set(['completed', 'cancelled']);

function taskIdByName(ctx: EngineContext, name: string): string | null {
    if (!advertises(ctx, KNOWN_CAPABILITIES.tasks)) return null;
    for (const { task } of ctx.state.tasks.values()) if (task.name === name) return task.id;
    return null;
}

/** The thread created or linked a task: a `linked` entry, and the task's live state in the thread's `tasks`. */
export function linkTask(ctx: EngineContext, record: ChatRecord, input: ChatTaskInput): ChatTask {
    if (record.tasks.some(({ name }) => name === input.name)) throw new Error(`Task ${input.name} is already linked`);
    if (record.tasks.length >= MAX_CHAT_TASKS)
        throw new Error(`A thread links at most ${String(MAX_CHAT_TASKS)} tasks`);
    const task = ChatTask.parse({
        taskId: input.taskId === undefined ? taskIdByName(ctx, input.name) : input.taskId,
        state: 'queued',
        detail: null,
        agentId: null,
        commit: null,
        reopened: false,
        startedAt: null,
        endedAt: null,
        ...input,
    });
    link(ctx, record, task);
    return task;
}

/**
 * A linked task moved on, as the engine's task state reports it: it started the first time it runs, it ended when it
 * finishes, and a completed or cancelled task that becomes active again is reopened.
 */
export function changeTask(ctx: EngineContext, record: ChatRecord, name: string, change: ChatTaskChange): ChatTask {
    const index = record.tasks.findIndex((task) => task.name === name);
    const current = record.tasks[index];
    if (current === undefined) throw new Error(`Task ${name} is not linked in ${record.id}`);
    const state = change.state ?? current.state;
    const finished = FINISHED.has(state);
    const reopens = !finished && CLOSED.has(current.state);
    const now = ctx.now();
    const next = ChatTask.parse({
        ...current,
        ...change,
        state,
        reopened: current.reopened || reopens,
        startedAt: current.startedAt ?? (state === 'running' ? now : null),
        endedAt: finished ? (FINISHED.has(current.state) ? current.endedAt : now) : null,
    });
    record.tasks[index] = next;
    return next;
}
