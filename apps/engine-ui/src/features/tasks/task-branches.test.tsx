import { KNOWN_CAPABILITIES, PERMISSIONS } from '@ptbk/engine-api';
import { createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineApiOptions, InMemorySeedRun, InMemorySeedTask } from '@ptbk/engine-api/in-memory';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;
const AT = TEST_NOW.toISOString();

type SeedTask = InMemorySeedTask['task'];

function task(id: string, name: string, fields: Partial<SeedTask> = {}): SeedTask {
    return {
        id,
        name,
        kind: 'ordinary',
        purpose: null,
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
        sourcePath: null,
        allowedActions: [],
        updatedAt: AT,
        ...fields,
    };
}

function run(id: string): InMemorySeedRun {
    return {
        id,
        agentId: 'agent-ada',
        source: 'member',
        status: 'completed',
        chatId: null,
        messageId: null,
        triggerId: null,
        retryOf: null,
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
}

const SEED_TASKS: readonly InMemorySeedTask[] = [
    // Nothing to say about it: no agent, no meta line, no relations, no reason.
    { task: task('task-bare', 'Bare task') },
    { task: task('task-alone', 'Alone') },
    {
        task: task('task-prereq-failed', 'Failed prerequisite', { state: 'failed', agentId: 'agent-ada' }),
    },
    {
        task: task('task-busy', 'Busy task', {
            agentId: 'agent-ghost',
            agentName: null,
            purpose: 'system',
            priority: { rank: 3, text: null },
            dueAt: AT,
            conditions: [{ kind: 'resource', met: true, text: 'A tool is free' }],
            dependsOn: [
                { taskId: 'task-prereq-failed', name: 'Failed prerequisite', state: 'failed' },
                { taskId: 'task-loop', name: 'Loop', state: 'cycle' },
            ],
            origin: { kind: 'task', chatId: null, taskId: 'task-bare', text: null },
        }),
        links: [
            { direction: 'outgoing', target: { type: 'chat', chatId: null, name: 'Unresolved chat' } },
            { direction: 'outgoing', target: { type: 'chat', chatId: 'chat-plan', name: 'Plan' } },
            { direction: 'outgoing', target: { type: 'agent', agentId: 'agent-ada', name: 'Ada' } },
            { direction: 'outgoing', target: { type: 'task', taskId: 'task-bare', name: 'Bare task' } },
        ],
        occurrences: [
            {
                id: 'occ-busy-1',
                taskId: 'task-busy',
                sequence: 1,
                cycle: 1,
                reason: 'first',
                retryOf: null,
                state: 'completed',
                scheduledFor: null,
                startedAt: AT,
                endedAt: AT,
                summary: null,
                runIds: ['run-a', 'run-b'],
            },
        ],
    },
    { task: task('task-loop', 'Loop', { state: 'blocked' }) },
    {
        task: task('task-update', 'Engine update', {
            kind: 'engine',
            purpose: 'system',
            state: 'not-ready',
            origin: { kind: 'user', chatId: null, taskId: null, text: null },
        }),
    },
    {
        task: task('task-from-chat', 'From a chat', {
            agentId: 'agent-ada',
            origin: { kind: 'chat', chatId: 'chat-plan', taskId: null, text: 'Chat {Plan}' },
        }),
    },
    {
        task: task('task-conversion', 'Converted', {
            origin: { kind: 'conversion', chatId: null, taskId: null, text: null },
        }),
        links: [{ direction: 'incoming', target: { type: 'agent', agentId: 'agent-ada', name: 'Ada' } }],
    },
];

function engine(options: InMemoryEngineApiOptions = {}) {
    return createInMemoryEngineApiClient({
        clock: { now: () => TEST_NOW },
        seed: {
            agents: [{ id: 'agent-ada', source: 'Ada\nPERSONA Research' }],
            chats: [
                {
                    id: 'chat-plan',
                    title: 'Plan',
                    createdAt: AT,
                    entries: [{ type: 'joined', participant: { kind: 'agent', key: 'agent-ada' } }],
                },
            ],
            runs: [run('run-a'), run('run-b')],
            tasks: SEED_TASKS,
        },
        ...options,
    });
}

describe('task screens, the less common cases', { timeout: TIMEOUT_MS }, () => {
    it('lists tasks without an agent or meta, and system work, and has no run history without runs@1', async () => {
        renderWithProviders({
            path: '/tasks',
            engineApi: engine({ capabilities: [KNOWN_CAPABILITIES.tasks] }),
        });
        await screen.findByRole('link', { name: 'Bare task' });
        expect(screen.queryByRole('link', { name: 'Run history' })).toBeNull();
        const busy = screen.getByRole('link', { name: 'Busy task' }).closest('tr');
        if (busy === null) throw new Error('no row');
        expect(within(busy).getByText('System')).toBeTruthy();
        expect(within(busy).getByText('P3')).toBeTruthy();
    });

    it('says when there are no tasks at all, and keeps an agent from the URL it does not list', async () => {
        const empty = createInMemoryEngineApiClient({ clock: { now: () => TEST_NOW }, seed: {} });
        const { unmount } = renderWithProviders({ path: '/tasks', engineApi: empty });
        expect(await screen.findByText('No tasks yet')).toBeTruthy();
        unmount();

        const { user, router } = renderWithProviders({ path: '/tasks?agentId=agent-gone', engineApi: engine() });
        await screen.findByText('No task matches');
        // An agent the first page of agents does not list still shows, by its ID from the URL.
        await user.click(screen.getByRole('button', { name: 'Agent: agent-gone' }));
        const agents = within(screen.getByRole('dialog')).getByRole('listbox', { name: 'Agent' });
        await user.click(await within(agents).findByRole('option', { name: 'Ada' }));
        await waitFor(() => {
            expect(router.state.location.search).toMatchObject({ agentId: 'agent-ada' });
        });
        await user.keyboard('{Escape}');
        await user.click(screen.getByRole('button', { name: 'Filter' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('option', { name: 'Kind' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('option', { name: 'Built-in tasks' }));
        await waitFor(() => {
            expect(router.state.location.search).toMatchObject({ kind: 'engine' });
        });
    });

    it('drops the status filter when its last group is unchecked', async () => {
        const { user, router } = renderWithProviders({ path: '/tasks?status=ready', engineApi: engine() });
        await screen.findByRole('link', { name: 'Bare task' });
        await user.click(screen.getByRole('button', { name: 'Status: Ready' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('option', { name: 'Ready' }));
        await waitFor(() => {
            expect(router.state.location.search).not.toHaveProperty('status');
        });
    });

    it('shows a bare task with nothing related and nothing to explain', async () => {
        renderWithProviders({ path: '/tasks/task-alone', engineApi: engine() });
        await screen.findByRole('heading', { level: 1, name: 'Alone' });
        expect(screen.queryByRole('region', { name: 'Related' })).toBeNull();
        expect(screen.getByText('No agent yet')).toBeTruthy();
        expect(await screen.findByText('It has not run yet.')).toBeTruthy();
    });

    it('shows standings, met conditions, unresolved links and several runs of one occurrence', async () => {
        renderWithProviders({ path: '/tasks/task-busy', engineApi: engine() });
        await screen.findByRole('heading', { level: 1, name: 'Busy task' });
        expect(screen.getByText('agent-ghost')).toBeTruthy();
        expect(screen.getByText('P3')).toBeTruthy();
        expect(screen.getByText('Met:')).toBeTruthy();
        const related = screen.getByRole('region', { name: 'Related' });
        expect(within(related).getByText('Did not succeed')).toBeTruthy();
        expect(within(related).getByText('Circular')).toBeTruthy();
        expect(within(related).getByText('Unresolved chat')).toBeTruthy();
        expect(within(related).getByRole('link', { name: 'Another task' }).getAttribute('href')).toBe(
            '/tasks/task-bare',
        );
        expect(within(related).getByRole('link', { name: 'Ada' }).getAttribute('href')).toBe('/agents/agent-ada');
        expect((await within(related).findByRole('link', { name: 'Plan' })).getAttribute('href')).toBe(
            '/chats/chat-plan',
        );
        // The first linked chat is where to discuss it when the task did not come from one.
        expect((await screen.findByRole('link', { name: 'Discuss in chat' })).getAttribute('href')).toBe(
            '/chats/chat-plan',
        );
        const history = screen.getByRole('region', { name: 'History' });
        expect((await within(history).findByRole('link', { name: 'Run 2' })).getAttribute('href')).toBe('/runs/run-b');
    });

    it('names an engine task without an executor, and origins without text', async () => {
        const { unmount } = renderWithProviders({ path: '/tasks/task-update', engineApi: engine() });
        await screen.findByRole('heading', { level: 1, name: 'Engine update' });
        expect(screen.getAllByText('The engine').length).toBeGreaterThan(0);
        expect(screen.getByText('Added by you')).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Discuss in chat' })).toBeNull();
        unmount();

        const second = renderWithProviders({ path: '/tasks/task-conversion', engineApi: engine() });
        const related = await screen.findByRole('region', { name: 'Related' });
        expect(within(related).getByText('Unknown')).toBeTruthy();
        expect(within(related).getByText('Linked from')).toBeTruthy();
        second.unmount();

        renderWithProviders({ path: '/tasks/task-from-chat', engineApi: engine() });
        const fromChat = await screen.findByRole('region', { name: 'Related' });
        expect((await within(fromChat).findByRole('link', { name: 'A chat' })).getAttribute('href')).toBe(
            '/chats/chat-plan',
        );
    });

    it('offers no chat to a member without chats.read, and treats a malformed ID as not found', async () => {
        const { unmount } = renderWithProviders({
            path: '/tasks/task-from-chat',
            engineApi: engine({
                member: {
                    id: 'member-owner',
                    role: 'member',
                    permissions: PERMISSIONS.filter((permission) => permission !== 'chats.read'),
                },
            }),
        });
        await screen.findByRole('heading', { level: 1, name: 'From a chat' });
        expect(screen.queryByRole('link', { name: 'Discuss in chat' })).toBeNull();
        unmount();

        renderWithProviders({ path: '/tasks/not%20an%20id', engineApi: engine() });
        expect(await screen.findByRole('heading', { level: 1, name: 'Task not found' })).toBeTruthy();
    });

    it('shows no task link on a run without tasks@1', async () => {
        const seed = { runs: [{ ...run('run-a'), taskId: 'task-busy', occurrenceId: 'occ-busy-1' }] };
        renderWithProviders({
            path: '/runs/run-a',
            engineApi: createInMemoryEngineApiClient({
                clock: { now: () => TEST_NOW },
                seed: { agents: [{ id: 'agent-ada', source: 'Ada' }], ...seed },
                capabilities: [KNOWN_CAPABILITIES.runs],
            }),
        });
        await screen.findByRole('link', { name: 'Ada' });
        expect(screen.queryByRole('link', { name: 'Task' })).toBeNull();
    });
});
