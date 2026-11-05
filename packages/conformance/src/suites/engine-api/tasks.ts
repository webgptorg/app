import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { Task, TaskDetail } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, skip } from '../../check';
import { checkFilter, requireCapability } from './capability-support';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
/** Tasks whose relations and occurrences a check reads; enough to meet every kind without walking a large project. */
const SAMPLE = 25;
const UNKNOWN_TASK_ID = 'conformance-no-such-task';

async function sampleTasks(world: World): Promise<readonly Task[]> {
    const { items } = await world.owner.ok(R.listTasks, { query: { limit: SAMPLE } });
    if (items.length === 0) skip('the engine reports no task');
    return items;
}

/** Each task's own fields agree with each other, as the engine's projections require. */
function checkTaskFields(findings: Findings, task: Task): void {
    const where = `task ${task.id}`;
    if (task.kind === 'engine' && task.sourcePath !== null) {
        findings.add(`${where}: an engine-owned task names a project source`);
    }
    if (task.reopened && task.doneCount === 0) findings.add(`${where}: reopened, but never completed`);
    if ((task.doneCount === 0) !== (task.lastDoneAt === null)) {
        findings.add(`${where}: doneCount and lastDoneAt disagree about whether it ever completed`);
    }
    if (task.progress !== null && task.progress.completed > task.progress.total) {
        findings.add(`${where}: progress counts more completed items than it has`);
    }
    if (task.parent?.taskId === task.id) findings.add(`${where}: is its own parent`);
}

/** Children, dependants and dependency standings answer the same graph from both ends. */
async function checkRelations(world: World, findings: Findings, task: TaskDetail): Promise<void> {
    const where = `task ${task.id}`;
    const parentId = task.parent?.taskId ?? null;
    if (parentId !== null) {
        const parent = await world.owner.ok(R.getTask, { params: { taskId: parentId } });
        if (!parent.children.some(({ taskId }) => taskId === task.id)) {
            findings.add(`${where}: its parent ${parentId} does not list it among its children`);
        }
    }
    for (const dependency of task.dependsOn) {
        if (dependency.taskId === null) {
            if (dependency.state !== 'missing') {
                findings.add(`${where}: an unresolved dependency is ${dependency.state}, not missing`);
            }
            continue;
        }
        const target = await world.owner.ok(R.getTask, { params: { taskId: dependency.taskId } });
        if (!target.blocks.some(({ taskId }) => taskId === task.id)) {
            findings.add(`${where}: its prerequisite ${dependency.taskId} does not list it under blocks`);
        }
        if (dependency.state === 'met' && target.state !== 'done') {
            findings.add(`${where}: a dependency on a ${target.state} task is met; only a successful one is`);
        }
    }
    for (const child of task.children) {
        const read = await world.owner.ok(R.getTask, { params: { taskId: child.taskId ?? UNKNOWN_TASK_ID } });
        if (read.parent?.taskId !== task.id) findings.add(`${where}: lists ${read.id} as a child it is not parent of`);
    }
}

/** Occurrences come newest first, belong to the task, and each run they name links back to them. */
async function checkOccurrences(world: World, findings: Findings, task: Task, runs: boolean): Promise<void> {
    const where = `GET /tasks/${task.id}/occurrences`;
    const { items } = await world.owner.ok(R.listTaskOccurrences, {
        params: { taskId: task.id },
        query: { limit: 50 },
    });
    const ids = new Set(items.map(({ id }) => id));
    if (ids.size !== items.length) findings.add(`${where}: lists an occurrence twice`);
    items.forEach((occurrence, index) => {
        if (occurrence.taskId !== task.id) findings.add(`${where}: ${occurrence.id} belongs to ${occurrence.taskId}`);
        const newer = items[index - 1];
        if (newer !== undefined && newer.sequence <= occurrence.sequence) {
            findings.add(`${where}: not newest first at ${occurrence.id}`);
        }
        if (newer !== undefined && newer.cycle < occurrence.cycle) {
            findings.add(`${where}: a newer occurrence has an earlier work cycle than ${occurrence.id}`);
        }
        if (occurrence.reason === 'retry' && occurrence.retryOf === null) {
            findings.add(`${where}: retry ${occurrence.id} names no occurrence it retries`);
        }
        if (occurrence.retryOf !== null && ids.has(occurrence.retryOf)) {
            const retried = items.find(({ id }) => id === occurrence.retryOf);
            if (retried !== undefined && retried.state !== 'failed' && retried.state !== 'interrupted') {
                findings.add(`${where}: ${occurrence.id} retries an occurrence that is ${retried.state}`);
            }
        }
    });
    if (!runs) return;
    for (const occurrence of items.slice(0, 5)) {
        for (const runId of occurrence.runIds.slice(0, 3)) {
            const run = await world.owner.ok(R.getRun, { params: { runId } });
            if (run.taskId !== task.id || run.occurrenceId !== occurrence.id) {
                findings.add(`GET /runs/${runId}: does not link back to task ${task.id}, occurrence ${occurrence.id}`);
            }
        }
    }
}

export const TASK_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.tasks.inventory',
        suite: SUITE,
        title: 'GET /tasks lists every task, ordinary and engine-owned, and its filters list only matching tasks',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.tasks);
            const findings = new Findings();
            const tasks = await sampleTasks(world);
            for (const task of tasks) checkTaskFields(findings, task);
            await attempt(findings, async () => {
                const [sample] = tasks;
                if (sample === undefined) return;
                const byState = await world.owner.ok(R.listTasks, { query: { state: sample.state, limit: 50 } });
                checkFilter(findings, R.listTasks, 'state', byState.items, ({ state }) => state === sample.state);
                if (!byState.items.some(({ id }) => id === sample.id)) {
                    findings.add('GET /tasks: filtering by a task’s own state leaves the task out');
                }
                const byKind = await world.owner.ok(R.listTasks, { query: { kind: sample.kind, limit: 50 } });
                checkFilter(findings, R.listTasks, 'kind', byKind.items, ({ kind }) => kind === sample.kind);
                const owned = tasks.find(({ agentId }) => agentId !== null);
                if (owned?.agentId != null) {
                    const agentId = owned.agentId;
                    const byAgent = await world.owner.ok(R.listTasks, { query: { agentId, limit: 50 } });
                    checkFilter(findings, R.listTasks, 'agentId', byAgent.items, (task) => task.agentId === agentId);
                }
            });
            await attempt(findings, async () => {
                for (const task of tasks.slice(0, 5)) {
                    const read = await world.owner.ok(R.getTask, { params: { taskId: task.id } });
                    if (read.name !== task.name || read.kind !== task.kind) {
                        findings.add(`GET /tasks/${task.id}: answers another name or kind than the list`);
                    }
                }
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.tasks.relations',
        suite: SUITE,
        title: 'Parents and children, dependencies and the tasks they block agree from both ends',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.tasks);
            const findings = new Findings();
            const tasks = await sampleTasks(world);
            const related = tasks.filter((task) => task.parent !== null || task.dependsOn.length > 0);
            if (related.length === 0) skip('no listed task has a parent or a dependency');
            for (const task of related.slice(0, 10)) {
                await attempt(findings, async () => {
                    const detail = await world.owner.ok(R.getTask, { params: { taskId: task.id } });
                    await checkRelations(world, findings, detail);
                });
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.tasks.occurrences',
        suite: SUITE,
        title: 'Occurrences come newest first under their task, retries name what they retry, runs link back',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.tasks);
            const findings = new Findings();
            const runs = supports(await world.engine(), KNOWN_CAPABILITIES.runs);
            const tasks = await sampleTasks(world);
            const ran = tasks.filter((task) => task.doneCount > 0 || task.repeat !== null);
            if (ran.length === 0) skip('no listed task has completed or repeats');
            for (const task of ran.slice(0, 8)) {
                await attempt(findings, () => checkOccurrences(world, findings, task, runs));
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.tasks.unknown',
        suite: SUITE,
        title: 'An unknown task answers 404 not-found, for the task and for its occurrences',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.tasks);
            const findings = new Findings();
            const params = { taskId: UNKNOWN_TASK_ID };
            await attempt(findings, async () => {
                await world.owner.problem(R.getTask, { params }, 'not-found');
            });
            await attempt(findings, async () => {
                await world.owner.problem(R.listTaskOccurrences, { params }, 'not-found');
            });
            return findings.outcome();
        },
    },
];
