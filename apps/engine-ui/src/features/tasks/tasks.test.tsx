import { KNOWN_CAPABILITIES, PERMISSIONS } from '@ptbk/engine-api';
import type { EngineApiClient } from '@ptbk/engine-api';
import { createDemoSeed, createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineApiOptions } from '@ptbk/engine-api/in-memory';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { HOSTILE } from '../../testing/runs-engine';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

function demoEngine(options: InMemoryEngineApiOptions = {}): EngineApiClient {
    return createInMemoryEngineApiClient({
        clock: { now: () => TEST_NOW },
        seed: createDemoSeed(TEST_NOW),
        ...options,
    });
}

/** The list's groups in order, each with its tasks' names as the rows show them. */
function groups(): Record<string, (string | null)[]> {
    const table = screen.getByRole('table', { name: 'Tasks' });
    const result: Record<string, (string | null)[]> = {};
    let current: (string | null)[] = [];
    for (const row of within(table).getAllByRole('row').slice(1)) {
        const header = row.querySelector('th[scope="rowgroup"]');
        if (header !== null) {
            current = [];
            // The header is the group's name followed by its count.
            result[header.textContent.replace(/\d+$/, '')] = current;
            continue;
        }
        current.push(row.querySelector('a[href^="/tasks/"]')?.textContent ?? null);
    }
    return result;
}

const firstRow = () => screen.findByRole('link', { name: 'Ship billing v2' });

describe('tasks', { timeout: TIMEOUT_MS }, () => {
    it("groups the engine's tasks into now, coming up and finished, in the engine's order", async () => {
        const { container } = renderWithProviders({ path: '/tasks', engineApi: demoEngine() });
        await firstRow();
        // Readable names; Reborn's instance stamps stay beside them as quiet text.
        expect(groups()).toEqual({
            Now: ['Ship billing v2', 'Migrate the old invoices'],
            'Coming up': ['Weekly report', 'Deploy billing v2', 'Update Promptbook 0.119.0 → 0.120.0'],
            Finished: ['Marketingový text webu o agentech pro IT profesionály', 'Review the billing pull request'],
        });
        expect(screen.getAllByText('2026-10-30 09:00').length).toBeGreaterThan(0);
        expect(screen.getByText('Dependency {Export invoices from the old system} was not found.')).toBeTruthy();
        expect(screen.getByText('Engine')).toBeTruthy();
        expect(screen.getAllByRole('link', { name: 'Ada' })[0]?.getAttribute('href')).toBe('/agents/agent-ada');
        expect(screen.getByRole('link', { name: 'Run history' }).getAttribute('href')).toBe('/runs');
        expect(screen.queryByRole('button', { name: /cancel|retry|delete/i })).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('sends the status groups as engine states and keeps them in the URL', async () => {
        const engineApi = demoEngine();
        const list = vi.spyOn(engineApi.tasks, 'list');
        const { user, router } = renderWithProviders({ path: '/tasks', engineApi });
        await firstRow();
        await user.click(screen.getByRole('button', { name: 'Filter' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('option', { name: 'Status' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('option', { name: 'Blocked or failed' }));
        await user.keyboard('{Escape}');
        await waitFor(() => {
            expect(router.state.location.search).toMatchObject({ status: 'blocked' });
        });
        await waitFor(() => {
            expect(list.mock.calls.at(-1)?.[0]).toMatchObject({
                state: 'blocked,failed,needs-recovery,incompatible',
            });
        });
        await waitFor(() => {
            expect(Object.keys(groups())).toEqual(['Now']);
        });
        expect(screen.getByRole('button', { name: 'Status: Blocked or failed' })).toBeTruthy();
    });

    it('offers to clear a filter that leaves nothing', async () => {
        const { user, router } = renderWithProviders({ path: '/tasks?status=retired', engineApi: demoEngine() });
        await screen.findByText('No task matches');
        const [, emptyStateClear] = screen.getAllByRole('button', { name: 'Clear filters' });
        if (emptyStateClear === undefined) throw new Error('no clear action in the empty state');
        await user.click(emptyStateClear);
        await firstRow();
        expect(router.state.location.search).not.toHaveProperty('status');
    });

    it('shows a task with its relations, conditions and history, and offers its chat to discuss it', async () => {
        const { container } = renderWithProviders({
            path: '/tasks/task-ship-billing',
            engineApi: demoEngine(),
        });
        await screen.findByRole('heading', { level: 1, name: 'Ship billing v2 2026-10-30 09:00' });
        expect(
            within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
                .getByRole('link', { name: 'Tasks' })
                .getAttribute('href'),
        ).toBe('/tasks');
        expect(screen.queryByRole('link', { name: 'Back to tasks' })).toBeNull();
        const related = screen.getByRole('region', { name: 'Related' });
        await waitFor(() => {
            expect(
                within(related).getAllByRole('link', { name: 'Review the billing PR' })[0]?.getAttribute('href'),
            ).toBe('/chats/chat-ada-1');
        });
        expect(
            within(related)
                .getByRole('link', { name: /^Deploy billing v2/ })
                .getAttribute('href'),
        ).toBe('/tasks/task-deploy-billing');
        expect((await screen.findByRole('link', { name: 'Discuss in chat' })).getAttribute('href')).toBe(
            '/chats/chat-ada-1',
        );
        expect(await screen.findByText('It has not run yet.')).toBeTruthy();
        await expectNoAxeViolations(container);
    });

    it('lists occurrences newest first with their runs, and dependencies with their standing', async () => {
        const { user } = renderWithProviders({ path: '/tasks/task-weekly-report', engineApi: demoEngine() });
        const history = await screen.findByRole('region', { name: 'History' });
        await within(history).findByText('#2 · Retry');
        const items = within(history).getAllByRole('row').slice(1);
        expect(items.map((item) => item.textContent)).toEqual([
            expect.stringContaining('#3 · Scheduled'),
            expect.stringContaining('#2 · Retry'),
            expect.stringContaining('#1 · Scheduled'),
        ]);
        expect(
            within(items[1] ?? history)
                .getByRole('link', { name: 'Open run' })
                .getAttribute('href'),
        ).toBe('/runs/run-iris-weekly');

        await user.click(
            within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Tasks' }),
        );
        await user.click(await screen.findByRole('link', { name: /^Deploy billing v2/ }));
        const related = await screen.findByRole('region', { name: 'Related' });
        expect(within(related).getByText('Done')).toBeTruthy();
        expect(within(related).getByText('Not done yet')).toBeTruthy();
    });

    it('renders task text from Books and agents as text, never markup', async () => {
        const seed = createDemoSeed(TEST_NOW);
        const tasks = (seed.tasks ?? []).map((record) =>
            record.task.id === 'task-migrate-invoices'
                ? { ...record, task: { ...record.task, name: HOSTILE, stateReason: HOSTILE }, notes: [HOSTILE] }
                : record,
        );
        const engineApi = createInMemoryEngineApiClient({ clock: { now: () => TEST_NOW }, seed: { ...seed, tasks } });
        const { container } = renderWithProviders({ path: '/tasks/task-migrate-invoices', engineApi });
        await screen.findByRole('heading', { level: 1, name: HOSTILE });
        expect(container.querySelector('img, script')).toBeNull();
        expect(screen.getAllByText(HOSTILE).length).toBeGreaterThanOrEqual(3);
    });

    it('says when a task is gone', async () => {
        renderWithProviders({ path: '/tasks/task-none', engineApi: demoEngine() });
        expect(await screen.findByRole('heading', { level: 1, name: 'Task not found' })).toBeTruthy();
    });

    it('links a run to the task it worked on', async () => {
        renderWithProviders({ path: '/runs/run-iris-weekly', engineApi: demoEngine() });
        expect(
            (await screen.findByRole('link', { name: 'Weekly report — 2026-10-01 08:00:00' })).getAttribute('href'),
        ).toBe('/tasks/task-weekly-report');
    });

    it('hides Tasks without tasks@1 or without tasks.read', async () => {
        renderWithProviders({
            path: '/agents',
            engineApi: demoEngine({ capabilities: [KNOWN_CAPABILITIES.runs] }),
        });
        await screen.findByRole('link', { name: 'Runs' });
        expect(screen.queryByRole('link', { name: 'Tasks' })).toBeNull();
    });

    it('hides Tasks from a member without tasks.read', async () => {
        renderWithProviders({
            path: '/agents',
            engineApi: demoEngine({
                member: {
                    id: 'member-owner',
                    role: 'member',
                    permissions: PERMISSIONS.filter((permission) => permission !== 'tasks.read'),
                },
            }),
        });
        await screen.findByRole('link', { name: 'Runs' });
        expect(screen.queryByRole('link', { name: 'Tasks' })).toBeNull();
    });

    it('pages the inventory and the history on with "Show more"', async () => {
        const seed = createDemoSeed(TEST_NOW);
        const tasks = seed.tasks ?? [];
        const weekly = tasks.find(({ task }) => task.id === 'task-weekly-report');
        if (weekly === undefined) throw new Error('the demo seed changed');
        const filler = Array.from({ length: 55 }, (_, index) => ({
            task: {
                ...weekly.task,
                id: `task-filler-${String(index)}`,
                name: `Filler ${String(index)}`,
                state: 'done' as const,
            },
        }));
        const occurrences = Array.from({ length: 55 }, (_, index) => ({
            id: `occ-many-${String(index)}`,
            taskId: 'task-weekly-report',
            sequence: index + 1,
            cycle: index + 1,
            reason: 'repeat' as const,
            retryOf: null,
            state: 'completed' as const,
            scheduledFor: null,
            startedAt: null,
            endedAt: null,
            summary: null,
            runIds: [],
        }));
        const engineApi = createInMemoryEngineApiClient({
            clock: { now: () => TEST_NOW },
            seed: {
                ...seed,
                runs: (seed.runs ?? []).map((run) => ({ ...run, taskId: null, occurrenceId: null })),
                tasks: [
                    ...tasks.map((record) => (record.task.id === weekly.task.id ? { ...record, occurrences } : record)),
                    ...filler,
                ],
            },
        });
        const { user, unmount } = renderWithProviders({ path: '/tasks', engineApi });
        await firstRow();
        expect(screen.queryByRole('link', { name: 'Filler 54' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Show more' }));
        await screen.findByRole('link', { name: 'Filler 54' });
        expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
        unmount();

        const detail = renderWithProviders({ path: '/tasks/task-weekly-report', engineApi });
        const history = await screen.findByRole('region', { name: 'History' });
        await within(history).findByText('#55 · Scheduled');
        expect(within(history).queryByText('#1 · Scheduled')).toBeNull();
        expect(within(history).getByText('Cycle 55')).toBeTruthy();
        await detail.user.click(within(history).getByRole('button', { name: 'Show more' }));
        await within(history).findByText('#1 · Scheduled');
    });

    it('shows an engine task by its executor, without a chat or a source', async () => {
        renderWithProviders({ path: '/tasks/task-engine-update', engineApi: demoEngine() });
        await screen.findByRole('heading', { level: 1, name: 'Update Promptbook 0.119.0 → 0.120.0' });
        expect(screen.getByText('Promptbook engine (deterministic update, no agent)')).toBeTruthy();
        expect(screen.getByText('Built into the engine')).toBeTruthy();
        expect(screen.getByText('The engine')).toBeTruthy();
        expect(
            within(screen.getByRole('region', { name: 'Before it can start' })).getByText('No task is running'),
        ).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Discuss in chat' })).toBeNull();
    });

    it('names where work came from and links agents it points to', async () => {
        const seed = createDemoSeed(TEST_NOW);
        const tasks = (seed.tasks ?? []).map((record) =>
            record.task.id === 'task-deploy-billing'
                ? {
                      ...record,
                      task: {
                          ...record.task,
                          agentId: null,
                          purpose: 'system' as const,
                          origin: { kind: 'goal' as const, chatId: null, taskId: null, text: null },
                          priority: { rank: 0, text: 'soon' },
                          notBefore: TEST_NOW.toISOString(),
                          dueAt: TEST_NOW.toISOString(),
                          reopened: true,
                          doneCount: 1,
                          lastDoneAt: TEST_NOW.toISOString(),
                      },
                      links: [
                          {
                              direction: 'outgoing' as const,
                              target: { type: 'agent' as const, agentId: null, name: 'Nobody' },
                          },
                          {
                              direction: 'outgoing' as const,
                              target: { type: 'task' as const, taskId: null, name: 'Old task' },
                          },
                      ],
                  }
                : record,
        );
        const engineApi = createInMemoryEngineApiClient({ clock: { now: () => TEST_NOW }, seed: { ...seed, tasks } });
        renderWithProviders({ path: '/tasks/task-deploy-billing', engineApi });
        const related = await screen.findByRole('region', { name: 'Related' });
        expect(within(related).getByText("Suggested from the agents' goals")).toBeTruthy();
        expect(within(related).getByText('Nobody')).toBeTruthy();
        expect(within(related).getByText('Old task')).toBeTruthy();
        expect(screen.getByText('No agent yet')).toBeTruthy();
        expect(screen.getAllByText('System').length).toBeGreaterThan(0);
        expect(screen.getByText('Yes, not completed since')).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Discuss in chat' })).toBeNull();
    });

    it('offers a retry when the list, a task or its history fails to load', async () => {
        const engineApi = demoEngine();
        vi.spyOn(engineApi.tasks, 'list').mockImplementation(() => problemResponse('validation-failed'));
        vi.spyOn(engineApi.tasks, 'listOccurrences').mockImplementation(() => problemResponse('validation-failed'));
        const { unmount } = renderWithProviders({ path: '/tasks', engineApi });
        expect(await screen.findByText('The tasks could not be loaded.')).toBeTruthy();
        unmount();
        renderWithProviders({ path: '/tasks/task-ship-billing', engineApi });
        expect(await screen.findByText('The history could not be loaded.')).toBeTruthy();

        const failing = demoEngine();
        vi.spyOn(failing.tasks, 'get').mockImplementation(() => problemResponse('validation-failed'));
        renderWithProviders({ path: '/tasks/task-ship-billing', engineApi: failing });
        expect(await screen.findByText('The task could not be loaded.')).toBeTruthy();
    });
});
