import { TASK_STATES } from '../capabilities/tasks';
import type { Task, TaskDependency, TaskDetail, TaskLink, TaskOccurrence, TaskState } from '../capabilities/tasks';
import { notFound, ok, page, sortBy } from './kit';
import type { EngineContext, Handlers } from './kit';

/** What the engine reads from a task's Book and runtime; relations to other tasks are resolved on every answer. */
export interface TaskRecord {
    readonly task: Task;
    /** Edges written in this task's Book, plus chat edges the chat's Book holds (chats keep no link list here). */
    readonly links: readonly TaskLink[];
    readonly notes: readonly string[];
    /** Oldest first. */
    readonly occurrences: readonly TaskOccurrence[];
}

const STATE_RANK = new Map<TaskState, number>(TASK_STATES.map((state, index) => [state, index]));
const PRIORITY_CEILING = 1_000_000;

/**
 * Stands in for the engine's smart default order (`TASK_STATES` is listed in it): current decisions, then upcoming,
 * then closed work; higher priority first within a state, then by name.
 */
function smartKey(task: Task): string {
    const state = String(STATE_RANK.get(task.state) ?? TASK_STATES.length).padStart(2, '0');
    const priority = String(PRIORITY_CEILING - task.priority.rank).padStart(7, '0');
    return `${state}|${priority}|${task.name.toLowerCase()}`;
}

function dependencyState(ctx: EngineContext, dependency: TaskDependency): TaskDependency['state'] {
    if (dependency.state === 'cycle') return 'cycle';
    const target = dependency.taskId === null ? undefined : ctx.state.tasks.get(dependency.taskId);
    if (target === undefined) return 'missing';
    if (target.task.state === 'done') return 'met';
    if (target.task.state === 'failed' || target.task.state === 'cancelled') return 'failed';
    return 'pending';
}

/** The task as the engine answers it: the agent's current name and each prerequisite's current standing. */
function view(ctx: EngineContext, task: Task): Task {
    const agentName = task.agentId === null ? null : (ctx.state.agents.get(task.agentId)?.agent.name ?? task.agentName);
    return {
        ...task,
        agentName,
        dependsOn: task.dependsOn.map((dependency) => ({ ...dependency, state: dependencyState(ctx, dependency) })),
    };
}

function detail(ctx: EngineContext, record: TaskRecord): TaskDetail {
    const id = record.task.id;
    const others = [...ctx.state.tasks.values()].filter((other) => other.task.id !== id);
    const ref = (other: TaskRecord) => ({ taskId: other.task.id, name: other.task.name, state: other.task.state });
    const incoming: TaskLink[] = others.flatMap((other) =>
        other.links.some(
            (link) => link.direction === 'outgoing' && link.target.type === 'task' && link.target.taskId === id,
        )
            ? [{ direction: 'incoming', target: { type: 'task', taskId: other.task.id, name: other.task.name } }]
            : [],
    );
    return {
        ...view(ctx, record.task),
        children: others.filter((other) => other.task.parent?.taskId === id).map(ref),
        blocks: others.filter((other) => other.task.dependsOn.some((dependency) => dependency.taskId === id)).map(ref),
        links: [...record.links, ...incoming],
        notes: [...record.notes],
    };
}

export const TASK_HANDLERS: Pick<Handlers, 'listTasks' | 'getTask' | 'listTaskOccurrences'> = {
    listTasks: ({ query }, ctx) => {
        const states = query.state === undefined ? undefined : new Set(query.state);
        const needle = query.q?.toLowerCase();
        const tasks = [...ctx.state.tasks.values()]
            .map((record) => record.task)
            .filter(
                (task) =>
                    (states === undefined || states.has(task.state)) &&
                    (query.kind === undefined || task.kind === query.kind) &&
                    (query.agentId === undefined || task.agentId === query.agentId) &&
                    (query.parentId === undefined || task.parent?.taskId === query.parentId) &&
                    (needle === undefined || task.name.toLowerCase().includes(needle)),
            )
            .map((task) => view(ctx, task));
        return page(tasks, sortBy('smart', smartKey), query);
    },
    getTask: ({ params }, ctx) => {
        const record = ctx.state.tasks.get(params.taskId);
        return record === undefined ? notFound('task') : ok(detail(ctx, record));
    },
    listTaskOccurrences: ({ params, query }, ctx) => {
        const record = ctx.state.tasks.get(params.taskId);
        if (record === undefined) return notFound('task');
        return page(
            record.occurrences,
            sortBy('-sequence', (occurrence) => occurrence.sequence, true),
            query,
        );
    },
};

/** Occurrences reference runs and tasks by ID; a seed that points nowhere is a bug in the seed, not engine data. */
export function checkTaskSeed(tasks: ReadonlyMap<string, TaskRecord>, runIds: ReadonlySet<string>): void {
    for (const { task, occurrences } of tasks.values()) {
        for (const occurrence of occurrences) {
            if (occurrence.taskId !== task.id) throw new Error(`Seeded occurrence ${occurrence.id} names another task`);
            for (const runId of occurrence.runIds) {
                if (!runIds.has(runId))
                    throw new Error(`Seeded occurrence ${occurrence.id} lists unknown run ${runId}`);
            }
        }
        if (task.parent?.taskId != null && !tasks.has(task.parent.taskId)) {
            throw new Error(`Seeded task ${task.id} has an unknown parent`);
        }
    }
}
