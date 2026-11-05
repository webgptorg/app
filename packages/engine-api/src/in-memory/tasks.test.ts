import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import type { EngineApiResponse } from '../client';
import { AgentId, RunId, TaskId } from '../common';
import { createInMemoryEngine } from '../in-memory-client';
import type { InMemoryEngineApiOptions, InMemorySeedRun, InMemorySeedTask } from '../in-memory-client';
import { PERMISSIONS } from '../permissions';

const AT = '2026-11-05T08:00:00Z';
const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function code(response: EngineApiResponse<unknown>): string {
    return response.kind === 'problem' ? response.problem.code : 'ok';
}

type SeedTask = InMemorySeedTask['task'];

function task(id: string, name: string, overrides: Partial<SeedTask> = {}): SeedTask {
    return {
        id,
        name,
        kind: 'ordinary',
        purpose: 'content',
        core: false,
        agentId: null,
        executor: null,
        priority: { rank: 0, text: null },
        state: 'ready',
        stateReason: null,
        next: null,
        conditions: [],
        repeat: null,
        notBefore: null,
        dueAt: null,
        nextAt: null,
        progress: null,
        parent: null,
        dependsOn: [],
        origin: null,
        doneCount: 0,
        lastDoneAt: null,
        reopened: false,
        sourcePath: `tasks/${id}.book`,
        allowedActions: [],
        updatedAt: AT,
        ...overrides,
    };
}

const RUN: InMemorySeedRun = {
    id: 'run-digest-1',
    agentId: 'agent-ada',
    source: 'schedule',
    status: 'completed',
    chatId: null,
    messageId: null,
    triggerId: null,
    retryOf: null,
    taskId: 'task-digest',
    occurrenceId: 'occ-digest-1',
    createdBy: null,
    queuedAt: AT,
    startedAt: AT,
    completedAt: AT,
    cancelRequestedAt: null,
    attemptCount: 1,
    runner: null,
    model: null,
    progress: null,
    usage: null,
    error: null,
    toolCalls: [],
    outputs: { messages: [], files: [], projectChanges: [] },
    report: { touchedProjects: [], externalSources: [] },
};

const SEED_TASKS: readonly InMemorySeedTask[] = [
    { task: task('task-launch', 'Launch the newsletter', { state: 'active', priority: { rank: 2, text: null } }) },
    {
        task: task('task-draft', 'Draft the first issue', {
            state: 'done',
            parent: { taskId: 'task-launch', name: 'Launch the newsletter' },
            doneCount: 1,
            lastDoneAt: AT,
        }),
        links: [{ direction: 'outgoing', target: { type: 'task', taskId: 'task-send', name: 'Send the first issue' } }],
    },
    {
        task: task('task-send', 'Send the first issue', {
            state: 'waiting-dependency',
            parent: { taskId: 'task-launch', name: 'Launch the newsletter' },
            dependsOn: [
                // The seed's stale `pending` is recomputed from the prerequisite, which is done.
                { taskId: 'task-draft', name: 'Draft the first issue', state: 'pending' },
                { taskId: 'task-review', name: 'Review the first issue', state: 'met' },
                { taskId: null, name: 'Gone task', state: 'pending' },
                { taskId: 'task-loop', name: 'Loop', state: 'cycle' },
                { taskId: 'task-digest', name: 'Weekly digest', state: 'met' },
            ],
        }),
        links: [{ direction: 'incoming', target: { type: 'chat', chatId: 'chat-plan', name: 'Plan the newsletter' } }],
        notes: ['Waits for the review.'],
    },
    { task: task('task-review', 'Review the first issue', { state: 'failed' }) },
    { task: task('task-loop', 'Loop', { state: 'blocked', agentId: 'agent-ghost', agentName: 'Ghost' }) },
    {
        task: task('task-digest', 'Weekly digest', {
            state: 'waiting-until',
            repeat: { text: '7d', intervalSeconds: 604_800 },
            agentId: 'agent-ada',
        }),
        occurrences: [
            {
                id: 'occ-digest-1',
                taskId: 'task-digest',
                sequence: 1,
                cycle: 1,
                reason: 'first',
                retryOf: null,
                state: 'completed',
                scheduledFor: AT,
                startedAt: AT,
                endedAt: AT,
                summary: 'Sent.',
                runIds: ['run-digest-1'],
            },
            {
                id: 'occ-digest-2',
                taskId: 'task-digest',
                sequence: 2,
                cycle: 2,
                reason: 'repeat',
                retryOf: null,
                state: 'pending',
                scheduledFor: AT,
                startedAt: null,
                endedAt: null,
                summary: null,
                runIds: [],
            },
        ],
    },
    {
        task: task('task-update', 'Update the engine to 0.120.0', {
            kind: 'engine',
            purpose: 'system',
            executor: 'self-update',
            sourcePath: null,
            state: 'waiting-until',
        }),
    },
];

function engine(options: InMemoryEngineApiOptions = {}) {
    return createInMemoryEngine({
        clock: { now: () => new Date(AT) },
        seed: { tasks: SEED_TASKS, runs: [RUN] },
        ...options,
    });
}

const id = (value: string) => TaskId.parse(value);

describe('tasks', () => {
    it("lists every task in the engine's default order: current work first, closed work last", async () => {
        const { client } = engine();
        const tasks = ok(await client.tasks.list({}, signal())).items;
        expect(tasks.map((item) => item.id)).toEqual([
            'task-launch',
            'task-review',
            'task-loop',
            'task-update',
            'task-digest',
            'task-send',
            'task-draft',
        ]);
    });

    it('filters by state set, kind, agent, parent and name, and pages', async () => {
        const { client } = engine();
        const names = async (query: Parameters<typeof client.tasks.list>[0]) =>
            ok(await client.tasks.list(query, signal())).items.map((item) => item.id);
        expect(await names({ state: 'done,failed' })).toEqual(['task-review', 'task-draft']);
        expect(await names({ kind: 'engine' })).toEqual(['task-update']);
        expect(await names({ agentId: AgentId.parse('agent-ada') })).toEqual(['task-digest']);
        expect(await names({ parentId: id('task-launch') })).toEqual(['task-send', 'task-draft']);
        expect(await names({ q: 'FIRST' })).toEqual(['task-review', 'task-send', 'task-draft']);
        const first = ok(await client.tasks.list({ limit: 2 }, signal()));
        expect(first.items).toHaveLength(2);
        const rest = ok(await client.tasks.list({ limit: 10, cursor: first.nextCursor ?? '' }, signal()));
        expect(rest.items.map((item) => item.id)).not.toContain('task-launch');
        expect(rest.nextCursor).toBeNull();
    });

    it("answers dependencies with each prerequisite's current standing and the agent's name it last had", async () => {
        const { client } = engine();
        const send = ok(await client.tasks.get(id('task-send'), signal()));
        expect(send.dependsOn.map((dependency) => dependency.state)).toEqual([
            'met',
            'failed',
            'missing',
            'cycle',
            'pending',
        ]);
        expect(send.notes).toEqual(['Waits for the review.']);
        const loop = ok(await client.tasks.get(id('task-loop'), signal()));
        expect(loop.agentName).toBe('Ghost');
    });

    it('derives children, dependants and incoming task links on the detail', async () => {
        const { client } = engine();
        const launch = ok(await client.tasks.get(id('task-launch'), signal()));
        expect(launch.children.map((child) => [child.taskId, child.state])).toEqual([
            ['task-draft', 'done'],
            ['task-send', 'waiting-dependency'],
        ]);
        const draft = ok(await client.tasks.get(id('task-draft'), signal()));
        expect(draft.blocks.map((dependant) => dependant.taskId)).toEqual(['task-send']);
        const send = ok(await client.tasks.get(id('task-send'), signal()));
        expect(send.links).toEqual([
            { direction: 'incoming', target: { type: 'chat', chatId: 'chat-plan', name: 'Plan the newsletter' } },
            { direction: 'incoming', target: { type: 'task', taskId: 'task-draft', name: 'Draft the first issue' } },
        ]);
    });

    it('lists occurrences newest first with their runs, and runs link back to their occurrence', async () => {
        const { client } = engine();
        const occurrences = ok(await client.tasks.listOccurrences(id('task-digest'), {}, signal())).items;
        expect(occurrences.map((occurrence) => [occurrence.sequence, occurrence.state])).toEqual([
            [2, 'pending'],
            [1, 'completed'],
        ]);
        const runs = ok(await client.runs.list({ taskId: id('task-digest') }, signal())).items;
        expect(runs.map((run) => [run.id, run.occurrenceId])).toEqual([['run-digest-1', 'occ-digest-1']]);
        expect(ok(await client.runs.list({ taskId: id('task-launch') }, signal())).items).toEqual([]);
        expect(ok(await client.runs.get(RunId.parse('run-digest-1'), signal())).taskId).toBe('task-digest');
    });

    it('answers 404 for an unknown task and its occurrences', async () => {
        const { client } = engine();
        expect(code(await client.tasks.get(id('task-none'), signal()))).toBe('not-found');
        expect(code(await client.tasks.listOccurrences(id('task-none'), {}, signal()))).toBe('not-found');
    });

    it('refuses an unknown state, a malformed task ID and an unknown query field', async () => {
        const { client } = engine();
        expect(code(await client.tasks.list({ state: 'done,paused' }, signal()))).toBe('validation-failed');
        expect(code(await client.tasks.list({ kind: 'system' } as never, signal()))).toBe('validation-failed');
        expect(code(await client.tasks.list({ sort: 'name' } as never, signal()))).toBe('validation-failed');
        expect(code(await client.tasks.get('no spaces allowed' as never, signal()))).toBe('validation-failed');
    });

    it('denies a member without tasks.read and answers capability-not-supported without tasks@1', async () => {
        const limited = engine({
            member: {
                id: 'member-limited',
                permissions: PERMISSIONS.filter((permission) => permission !== 'tasks.read'),
            },
        });
        expect(code(await limited.client.tasks.list({}, signal()))).toBe('forbidden');
        expect(code(await limited.client.tasks.get(id('task-launch'), signal()))).toBe('forbidden');
        const without = engine({ capabilities: [KNOWN_CAPABILITIES.runs] });
        expect(code(await without.client.tasks.list({}, signal()))).toBe('capability-not-supported');
    });

    it('refuses a seed whose occurrence names an unknown run, another task or an unknown parent', () => {
        const broken = (tasks: readonly InMemorySeedTask[]) => () =>
            createInMemoryEngine({ seed: { tasks, runs: [RUN] } });
        const digest = SEED_TASKS[5];
        if (digest?.occurrences?.[0] === undefined) throw new Error('seed changed');
        const occurrence = digest.occurrences[0];
        expect(broken([{ ...digest, occurrences: [{ ...occurrence, runIds: ['run-none'] }] }])).toThrow(/unknown run/);
        expect(broken([{ ...digest, occurrences: [{ ...occurrence, taskId: 'task-other' }] }])).toThrow(/another task/);
        expect(
            broken([{ task: task('task-orphan', 'Orphan', { parent: { taskId: 'task-none', name: 'None' } }) }]),
        ).toThrow(/unknown parent/);
    });
});
