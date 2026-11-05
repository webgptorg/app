import { KNOWN_CAPABILITIES, PERMISSIONS } from '@ptbk/engine-api';
import type { EngineApiClient } from '@ptbk/engine-api';
import { createDemoSeed, createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineApiOptions } from '@ptbk/engine-api/in-memory';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { HOSTILE } from '../../testing/runs-engine';
import { TEST_NOW } from '../../testing/test-engine-api';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

function demoEngine(options: InMemoryEngineApiOptions = {}): EngineApiClient {
    return createInMemoryEngineApiClient({
        clock: { now: () => TEST_NOW },
        seed: createDemoSeed(TEST_NOW),
        ...options,
    });
}

const sectionNames = (name: string) =>
    within(screen.getByRole('region', { name }))
        .getAllByRole('link')
        .map((link) => link.textContent);

describe('tasks', { timeout: TIMEOUT_MS }, () => {
    it("groups the engine's tasks into now, coming up and finished, in the engine's order", async () => {
        const { container } = renderWithProviders({ path: '/tasks', engineApi: demoEngine() });
        await screen.findByRole('region', { name: 'Now' });
        expect(sectionNames('Now')).toEqual([
            'Ship billing v2 — 2026-10-30 09:00:00',
            'Migrate the old invoices — 2026-10-30 09:07:00',
        ]);
        expect(sectionNames('Coming up')).toEqual([
            'Weekly report — 2026-10-01 08:00:00',
            'Deploy billing v2 — 2026-10-30 09:06:00',
            'Update Promptbook 0.119.0 → 0.120.0',
        ]);
        expect(sectionNames('Finished')).toEqual(['Review the billing pull request — 2026-10-30 09:05:00']);
        expect(screen.getByText('Dependency {Export invoices from the old system} was not found.')).toBeTruthy();
        expect(within(screen.getByRole('region', { name: 'Coming up' })).getByText('Engine')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Run history' }).getAttribute('href')).toBe('/runs');
        expect(screen.queryByRole('button', { name: /cancel|retry|delete/i })).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('sends the status groups as engine states and keeps them in the URL', async () => {
        const engineApi = demoEngine();
        const list = vi.spyOn(engineApi.tasks, 'list');
        const { user, router } = renderWithProviders({ path: '/tasks', engineApi });
        await screen.findByRole('region', { name: 'Now' });
        await user.click(screen.getByRole('button', { name: 'Status' }));
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Blocked or failed' }));
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
            expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();
        });
    });

    it('offers to clear a filter that leaves nothing', async () => {
        const { user, router } = renderWithProviders({ path: '/tasks?status=retired', engineApi: demoEngine() });
        await screen.findByText('No task matches');
        const [, emptyStateClear] = screen.getAllByRole('button', { name: 'Clear filters' });
        if (emptyStateClear === undefined) throw new Error('no clear action in the empty state');
        await user.click(emptyStateClear);
        await screen.findByRole('region', { name: 'Finished' });
        expect(router.state.location.search).not.toHaveProperty('status');
    });

    it('shows a task with its relations, conditions and history, and offers its chat to discuss it', async () => {
        const { container } = renderWithProviders({
            path: '/tasks/task-ship-billing',
            engineApi: demoEngine(),
        });
        await screen.findByRole('heading', { level: 1, name: 'Ship billing v2 — 2026-10-30 09:00:00' });
        const related = screen.getByRole('region', { name: 'Related' });
        await waitFor(() => {
            expect(
                within(related).getAllByRole('link', { name: 'Review the billing PR' })[0].getAttribute('href'),
            ).toBe('/agents/agent-ada/chat/chat-ada-1');
        });
        expect(
            within(related)
                .getByRole('link', { name: /^Deploy billing v2/ })
                .getAttribute('href'),
        ).toBe('/tasks/task-deploy-billing');
        expect((await screen.findByRole('link', { name: 'Discuss in chat' })).getAttribute('href')).toBe(
            '/agents/agent-ada/chat/chat-ada-1',
        );
        expect(await screen.findByText('It has not run yet.')).toBeTruthy();
        await expectNoAxeViolations(container);
    });

    it('lists occurrences newest first with their runs, and dependencies with their standing', async () => {
        const { user } = renderWithProviders({ path: '/tasks/task-weekly-report', engineApi: demoEngine() });
        const history = await screen.findByRole('region', { name: 'History' });
        await within(history).findByText('#2 · Retry');
        const items = within(history).getAllByRole('listitem');
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

        await user.click(screen.getByRole('link', { name: 'Back to tasks' }));
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
});
