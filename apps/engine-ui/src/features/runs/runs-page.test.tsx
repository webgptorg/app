import { KNOWN_CAPABILITIES, PERMISSIONS, RunId } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createRunsEngine, FILLER_RUNS, RUN_IDS } from '../../testing/runs-engine';
import type { RunsEngine } from '../../testing/runs-engine';
import { problemResponse } from '../../testing/test-engine-api';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

async function renderRuns(path = '/runs', engine: RunsEngine = createRunsEngine()) {
    const app = renderWithProviders({ path, engineApi: engine.client });
    await screen.findByRole('table');
    return { ...app, engine };
}

const table = () => screen.getByRole('table');
const dialog = () => screen.getByRole('dialog');
/** "+ Filter", then a field; the dialog then lists the field's values. */
async function addFilter(user: UserEvent, field: string) {
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(within(dialog()).getByRole('option', { name: field }));
}
const rowTitles = () =>
    within(table())
        .queryAllByRole('row')
        .slice(1)
        .map((row) => row.querySelector('a[href^="/runs/"]')?.textContent ?? '');
// The agent header's Stop lists the agent's active runs on its own; that query is not the timeline's.
const lastListQuery = (engine: RunsEngine) =>
    engine.spies.list.mock.calls.filter(([query]) => query.status !== 'queued,running').at(-1)?.[0];

describe('runs timeline', { timeout: TIMEOUT_MS }, () => {
    it('lists every run newest first and pages through the rest on the engine', async () => {
        const { user, engine, router } = await renderRuns();
        await within(table()).findByText('Refund for order 1042');
        expect(rowTitles()[0]).toBe('Refund for order 1042');
        expect(rowTitles()).toHaveLength(50);
        expect(lastListQuery(engine)).toEqual({ limit: 50 });

        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() => {
            expect(rowTitles()).toHaveLength(6 + FILLER_RUNS - 50);
        });
        expect(router.state.location.search).toHaveProperty('cursor');
        expect(lastListQuery(engine)).toMatchObject({ cursor: expect.any(String) as string });
    });

    it('writes status, source, agent and dates to the URL, sends them to the engine and restores them on reload', async () => {
        const { user, engine, router } = await renderRuns();
        await addFilter(user, 'Status');
        await user.click(within(dialog()).getByRole('option', { name: 'Failed' }));
        await user.click(within(dialog()).getByRole('option', { name: 'Queued' }));
        await user.keyboard('{Escape}');
        await waitFor(() => {
            expect(router.state.location.search).toMatchObject({ status: 'queued,failed' });
        });
        await waitFor(() => {
            expect(rowTitles()).toEqual(['Refund for order 1042', 'Write the weekly report']);
        });
        expect(lastListQuery(engine)).toMatchObject({ status: 'queued,failed' });

        await addFilter(user, 'Source');
        await user.click(within(dialog()).getByRole('option', { name: 'Schedule' }));
        await waitFor(() => {
            expect(rowTitles()).toEqual(['Write the weekly report']);
        });
        await addFilter(user, 'Agent');
        await user.click(await within(dialog()).findByRole('option', { name: 'Iris' }));
        await addFilter(user, 'Queued');
        await user.type(within(dialog()).getByLabelText('From'), '2026-10-01');
        await waitFor(() => {
            expect(router.state.location.search).toEqual({
                status: 'queued,failed',
                source: 'schedule',
                agentId: 'agent-iris',
                from: '2026-10-01',
            });
        });
        const filtered = lastListQuery(engine);
        expect(filtered).toMatchObject({ agentId: 'agent-iris', source: 'schedule', status: 'queued,failed' });
        expect(filtered?.from).toBe(new Date(2026, 9, 1).toISOString());

        // A reload: a fresh app at the same URL asks the engine the same question and shows the same chips.
        const href = router.state.location.href;
        const reloaded = createRunsEngine();
        renderWithProviders({ path: href, engineApi: reloaded.client });
        await waitFor(() => {
            expect(reloaded.spies.list).toHaveBeenCalledWith(filtered, expect.anything());
        });
        expect(screen.getAllByRole('button', { name: 'Status: Queued, Failed' })).not.toHaveLength(0);
        expect(await screen.findAllByRole('button', { name: 'Agent: Iris' })).not.toHaveLength(0);
    });

    it('turns the order around from the header and the Sort menu, in the URL', async () => {
        const { user, engine, router } = await renderRuns();
        await user.click(screen.getByRole('button', { name: 'Queued, Sorted descending' }));
        await waitFor(() => {
            expect(router.state.location.search).toEqual({ sort: 'queuedAt' });
        });
        expect(lastListQuery(engine)).toEqual({ limit: 50, sort: 'queuedAt' });
        await user.click(screen.getByRole('button', { name: 'Sorted by Queued, Sorted ascending' }));
        await user.click(screen.getByRole('menuitemradio', { name: 'Descending' }));
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
    });

    it('falls back to no filter for invalid search params instead of failing', async () => {
        const { engine, router } = await renderRuns(
            '/runs?status=failed,bogus&source=kiosk&agentId=%21&from=2026-02-30&cursor=%3D%3D',
        );
        expect(lastListQuery(engine)).toEqual({ limit: 50 });
        expect(router.state.location.search).toEqual({});
        expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
    });

    it('starts again from the first page when the engine refuses a stale cursor', async () => {
        const engine = createRunsEngine();
        engine.spies.list.mockImplementationOnce(() => problemResponse('invalid-cursor'));
        const { router } = renderWithProviders({ path: '/runs?cursor=stale', engineApi: engine.client });
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
        expect(await within(await screen.findByRole('table')).findByText('Refund for order 1042')).toBeDefined();
    });

    it('shows only the agent’s own runs on its tab, without the agent column or filter', async () => {
        const { engine, user } = await renderRuns('/agents/agent-ada/runs');
        await within(table()).findByText('Summarise open pull requests');
        expect(rowTitles()).toEqual([
            'Summarise open pull requests',
            'Review the billing pull request',
            'A run from a webhook',
        ]);
        expect(lastListQuery(engine)).toEqual({ limit: 50, agentId: 'agent-ada' });
        expect(within(table()).queryByRole('columnheader', { name: 'Agent' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Filter' }));
        expect(within(dialog()).queryByRole('option', { name: 'Agent' })).toBeNull();
        expect(within(table()).getByRole('link', { name: 'Summarise open pull requests' }).getAttribute('href')).toBe(
            `/runs/${RUN_IDS.running}?from=agent`,
        );
    });

    it('ignores an agentId in the search on an agent’s tab', async () => {
        const { engine } = await renderRuns('/agents/agent-ada/runs?agentId=agent-max');
        expect(lastListQuery(engine)).toEqual({ limit: 50, agentId: 'agent-ada' });
    });

    it('shows status as text, the agent, the source, a live duration and the cost', async () => {
        const { ticker } = await renderRuns();
        const row = (await within(table()).findByText('Summarise open pull requests')).closest('tr') as HTMLElement;
        expect(within(row).getByText('Running')).toBeDefined();
        expect(within(row).getByRole('link', { name: 'Ada' }).getAttribute('href')).toBe('/agents/agent-ada');
        expect(within(row).getByText('API')).toBeDefined();
        expect(within(row).getByText('1 min 30 s')).toBeDefined();
        ticker.advance(5_000);
        expect(within(row).getByText('1 min 35 s')).toBeDefined();

        const completed = within(table()).getByText('Review the billing pull request').closest('tr') as HTMLElement;
        expect(within(completed).getByText('$1,234.50')).toBeDefined();
        expect(within(completed).getByText('11 min 0 s')).toBeDefined();
        const cancelled = within(table()).getByText('A run from a webhook').closest('tr') as HTMLElement;
        expect(within(cancelled).getByText('Stopped')).toBeDefined();
        expect(within(cancelled).getByText('1 min 0 s')).toBeDefined();
        const queued = within(table()).getByText('Refund for order 1042').closest('tr') as HTMLElement;
        expect(within(queued).getAllByText('Not reported').length).toBeGreaterThan(0);
        expect(within(queued).queryByText('Unknown')).toBeNull();
        expect(
            within(table()).getByRole('link', { name: 'Review the billing pull request' }).getAttribute('href'),
        ).toBe(`/runs/${RUN_IDS.completed}`);
    });

    it('marks a retry and hides the cost column when no run on the page has a cost', async () => {
        const { engine } = await renderRuns('/agents/agent-iris/runs');
        await within(table()).findByText('Write the weekly report');
        expect(within(table()).queryByRole('columnheader', { name: 'Cost' })).toBeNull();
        expect(within(table()).queryByText('Retry of a failed run')).toBeNull();
        await engine.client.runs.retry(RunId.parse(RUN_IDS.failed), AbortSignal.timeout(1000));
        expect(await within(table()).findByText('Retry of a failed run')).toBeDefined();
    });

    it('calls a chat run’s source "Chat", not "Web"', async () => {
        await renderRuns();
        const row = (await within(table()).findByText('Review the billing pull request')).closest('tr') as HTMLElement;
        expect(within(row).getByText('Chat')).toBeDefined();
        expect(within(row).queryByText('Web')).toBeNull();
        expect(within(table()).getByRole('columnheader', { name: 'Cost' })).toBeDefined();
    });

    it('says there are no runs yet, globally and on an agent’s tab', async () => {
        const engine = createRunsEngine({
            seed: { agents: [{ id: 'agent-ada', source: 'Ada\nPERSONA Research' }] },
        });
        renderWithProviders({ path: '/runs', engineApi: engine.client });
        expect(await screen.findByText('No runs yet')).toBeDefined();
        expect(screen.getByText(/as soon as an agent starts working/)).toBeDefined();

        renderWithProviders({ path: '/agents/agent-ada/runs', engineApi: engine.client });
        expect(await screen.findByText(/This agent has not worked on anything yet/)).toBeDefined();
    });

    it('says when no run matches the filters, and clears them', async () => {
        const { user, router } = await renderRuns('/runs?source=member&status=queued');
        expect(await screen.findByText('No runs match these filters')).toBeDefined();
        await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
    });

    it('shows an error with retry when the list cannot be loaded', async () => {
        const engine = createRunsEngine();
        engine.spies.list.mockImplementation(() => problemResponse('validation-failed'));
        const { user } = renderWithProviders({ path: '/runs', engineApi: engine.client });
        expect(await screen.findByText('Runs could not be loaded.')).toBeDefined();
        engine.spies.list.mockRestore();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Refund for order 1042')).toBeDefined();
    });

    it('has no axe violations', async () => {
        const { container } = await renderRuns();
        await within(table()).findByText('Refund for order 1042');
        await expectNoAxeViolations(container);
    });
});

describe('runs access', { timeout: TIMEOUT_MS }, () => {
    it('without runs.read: no nav item and /runs says "no access"', async () => {
        renderWithProviders({ path: '/runs', permissions: allBut('runs.read', 'runs.control') });
        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
        const nav = screen.getByRole('navigation', { name: 'Main' });
        expect(within(nav).queryByRole('link', { name: 'Runs' })).toBeNull();
    });

    it('without runs@1: no nav item and /runs says "not available on this engine"', async () => {
        const without = Object.values(KNOWN_CAPABILITIES).filter(({ id }) => id !== 'runs');
        renderWithProviders({ path: '/runs', capabilities: without });
        expect(await screen.findByRole('heading', { level: 1, name: 'Not available on this engine' })).toBeDefined();
        const nav = screen.getByRole('navigation', { name: 'Main' });
        expect(within(nav).queryByRole('link', { name: 'Runs' })).toBeNull();
    });

    it('offers no stop or retry in the row menu without runs.control', async () => {
        await renderRuns('/runs', createRunsEngine({ permissions: allBut('runs.control') }));
        await within(table()).findByText('Refund for order 1042');
        expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    });

    it('offers stop for queued and running runs and retry only for failed ones, by keyboard', async () => {
        const { user, engine } = await renderRuns();
        await within(table()).findByText('Refund for order 1042');
        const menuItems = async (title: string) => {
            const trigger = screen.getByRole('button', { name: `Actions for ${title}` });
            trigger.focus();
            await user.keyboard('{Enter}');
            const menu = await screen.findByRole('menu', { name: `Actions for ${title}` });
            const items = within(menu)
                .getAllByRole('menuitem')
                .map((item) => item.textContent);
            await user.keyboard('{Escape}');
            return items;
        };
        expect(await menuItems('Refund for order 1042')).toEqual(['Stop']);
        expect(await menuItems('Summarise open pull requests')).toEqual(['Stop']);
        expect(await menuItems('Write the weekly report')).toEqual(['Retry']);
        expect(screen.queryByRole('button', { name: 'Actions for Review the billing pull request' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Actions for A run from a webhook' })).toBeNull();

        const trigger = screen.getByRole('button', { name: 'Actions for Refund for order 1042' });
        trigger.focus();
        await user.keyboard('{Enter}');
        await screen.findByRole('menu', { name: 'Actions for Refund for order 1042' });
        await user.keyboard('{Enter}');
        await waitFor(() => {
            expect(engine.spies.cancel).toHaveBeenCalledWith(RUN_IDS.queued, expect.anything());
        });
    });
});
