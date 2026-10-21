import { PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createRunsEngine, HOSTILE, LARGE_DIFF_LINES, RUN_IDS } from '../../testing/runs-engine';
import type { RunsEngine } from '../../testing/runs-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;

const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

async function renderRun(runId: string, engine: RunsEngine = createRunsEngine(), locale?: 'en' | 'cs') {
    const app = renderWithProviders({
        path: `/runs/${runId}`,
        engineApi: engine.client,
        ...(locale === undefined ? {} : { locale }),
    });
    await screen.findByRole('region', { name: locale === 'cs' ? 'Kroky' : 'Steps' });
    return { ...app, engine };
}

const section = (name: string) => screen.getByRole('region', { name });
const errorBanner = () => screen.getByText(/^The run failed:/).closest('[role="alert"]') as HTMLElement;
const statusFact = () => screen.getByText('Status', { selector: 'dt' }).parentElement as HTMLElement;

/** No element agent text could have turned into: images, scripts, frames or links with a target. */
function expectNoActiveContent(element: HTMLElement) {
    expect(element.querySelectorAll('img, script, iframe, object, embed').length).toBe(0);
    expect(element.querySelectorAll('a[href]').length).toBe(0);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('run detail', { timeout: TIMEOUT_MS }, () => {
    it('renders every section of a completed run with project changes', async () => {
        await renderRun(RUN_IDS.completed);
        expect(screen.getByRole('heading', { level: 1, name: 'Review the billing pull request' })).toBeDefined();
        expect(screen.getByText('Completed')).toBeDefined();
        expect(screen.getByRole('link', { name: 'Web, in a chat' }).getAttribute('href')).toBe(
            '/agents/agent-ada/chat/chat-ada',
        );
        expect(screen.getByRole('link', { name: 'Ada' }).getAttribute('href')).toBe('/agents/agent-ada');
        expect(screen.getByText('claude-code')).toBeDefined();
        expect(screen.getByText('claude-sonnet-4-5')).toBeDefined();

        const steps = section('Steps');
        expect(within(steps).getByText('Read the diff')).toBeDefined();

        const tools = section('Tool calls');
        expect(within(tools).getByText('github.get_pull_request')).toBeDefined();
        expect(within(tools).getByText('Complete')).toBeDefined();
        expect(within(tools).getByText('1 s')).toBeDefined();

        const usage = section('Usage and cost');
        expect(within(usage).getByText('18,200')).toBeDefined();
        expect(within(usage).getByText('2,150')).toBeDefined();
        expect(within(usage).getByText('11 min 0 s')).toBeDefined();
        expect(within(usage).getByText('$1,234.50')).toBeDefined();

        const outputs = section('Outputs');
        expect(within(outputs).getByRole('link', { name: 'Open the reply in its chat' })).toBeDefined();
        expect(within(outputs).getByRole('heading', { name: 'Changes in billing' })).toBeDefined();
        expect(within(outputs).getByText('+1')).toBeDefined();
        expect(within(outputs).getByText('−1')).toBeDefined();
        const diff = within(outputs).getByRole('region', { name: 'Diff of billing' });
        const line = (text: string) =>
            [...diff.querySelectorAll('div')].find((element) => element.textContent === text) as HTMLElement;
        expect(line('+    return items.reduce((a, b) => a + b, 0);').className).toContain('run-diff-added');
        expect(line('-    return items.reduce((a, b) => a + b);').className).toContain('run-diff-removed');
        expect(line('@@ -1,3 +1,3 @@').className).toContain('run-diff-hunk');
        expect(line(' }').className).not.toMatch(/run-diff/);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows a failed run’s error and offers retry, never cancel', async () => {
        await renderRun(RUN_IDS.failed);
        expect(errorBanner().textContent).toContain('The run failed: tool-timeout');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
    });

    it('shows "unknown" for usage the runner did not report', async () => {
        await renderRun(RUN_IDS.failed);
        const usage = section('Usage and cost');
        expect(within(usage).getAllByText('Unknown')).toHaveLength(4);
    });

    it('formats cost and numbers in Czech', async () => {
        await renderRun(RUN_IDS.completed, createRunsEngine(), 'cs');
        const usage = section('Spotřeba a cena');
        expect(within(usage).getByText('1 234,50 US$')).toBeDefined();
        expect(within(usage).getByText('18 200')).toBeDefined();
    });

    it('renders hostile tool logs, error summaries and diffs as literal text', async () => {
        const { user } = await renderRun(RUN_IDS.failed);
        await user.click(screen.getByText('calendar.list_events'));
        const tools = section('Tool calls');
        const logs = tools.querySelector('pre') as HTMLElement;
        expect(logs.textContent).toContain(HOSTILE);
        expect(within(tools).getByText(/The engine truncated this output/)).toBeDefined();
        expectNoActiveContent(tools);

        const banner = errorBanner();
        expect(banner.textContent).toContain(HOSTILE);
        expectNoActiveContent(banner);

        const diff = screen.getByRole('region', { name: 'Diff of reports' });
        expect(within(diff).getByText(`+${HOSTILE}`)).toBeDefined();
        expectNoActiveContent(diff);
        expect(document.querySelectorAll('img, script').length).toBe(0);
        expect(document.querySelectorAll('a[href^="javascript:"]').length).toBe(0);
    });

    it('mounts only the visible window of a 20,000-line diff and says the engine truncated it', async () => {
        // jsdom lays nothing out; give the scroll container the height a browser would.
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(512);
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
        await renderRun(RUN_IDS.largeDiff);
        const outputs = section('Outputs');
        expect(within(outputs).getByText(/The engine truncated this diff/)).toBeDefined();
        const diff = within(outputs).getByRole('region', { name: 'Diff of data' });
        const mounted = diff.querySelectorAll('.leading-5').length;
        expect(mounted).toBeGreaterThan(0);
        expect(mounted).toBeLessThan(200);
        expect(LARGE_DIFF_LINES).toBe(20_000);
    });

    it('follows a running run from events: steps refetch once per change, the time ticks without a fetch', async () => {
        const { engine, ticker } = await renderRun(RUN_IDS.running);
        const usage = section('Usage and cost');
        expect(within(usage).getByText('1 min 30 s')).toBeDefined();
        const gets = engine.spies.get.mock.calls.length;
        const lists = engine.spies.list.mock.calls.length;

        ticker.advance(10_000);
        expect(within(usage).getByText('1 min 40 s')).toBeDefined();
        expect(engine.spies.get.mock.calls.length).toBe(gets);

        act(() => {
            engine.controller.reportRunProgress(RUN_IDS.running, {
                progress: {
                    title: 'Summarise open pull requests',
                    now: 'Writing the summary',
                    next: null,
                    items: [
                        { id: 'p1', text: 'List open pull requests', status: 'completed' },
                        { id: 'p2', text: 'Read each one', status: 'completed' },
                        { id: 'p3', text: 'Write the summary', status: 'pending' },
                    ],
                },
            });
        });
        expect(await within(section('Steps')).findByText('Write the summary', { selector: 'li span' })).toBeDefined();
        expect(engine.spies.get.mock.calls.length).toBe(gets + 1);

        act(() => {
            engine.controller.advanceRun(RUN_IDS.running);
        });
        expect(await screen.findByText('Completed')).toBeDefined();
        expect(engine.spies.get.mock.calls.length).toBe(gets + 2);
        expect(engine.spies.list.mock.calls.length).toBe(lists);
    });

    it('says when the run does not exist', async () => {
        renderWithProviders({ path: '/runs/run-nope', engineApi: createRunsEngine().client });
        expect(await screen.findByRole('heading', { level: 1, name: 'Run not found' })).toBeDefined();
        expect(screen.getByRole('link', { name: 'Back to runs' }).getAttribute('href')).toBe('/runs');
    });

    it('shows an error with retry when the run cannot be loaded', async () => {
        const engine = createRunsEngine();
        engine.spies.get.mockImplementation(() => problemResponse('validation-failed'));
        const { user } = renderWithProviders({ path: `/runs/${RUN_IDS.completed}`, engineApi: engine.client });
        expect(await screen.findByText('This run could not be loaded.')).toBeDefined();
        engine.spies.get.mockRestore();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Review the billing pull request' })).toBeDefined();
    });

    it('has no axe violations', async () => {
        const { container } = await renderRun(RUN_IDS.completed);
        await expectNoAxeViolations(container);
    });
});

describe('run actions', { timeout: TIMEOUT_MS }, () => {
    it('cancels in one step: "Cancelling…" at once, then what the engine says', async () => {
        const engine = createRunsEngine();
        let release: () => void = () => undefined;
        // Once the held call is released it goes through the spy again, which then answers as the engine.
        const original: typeof engine.client.runs.cancel = (runId, signal) => engine.client.runs.cancel(runId, signal);
        engine.spies.cancel.mockImplementationOnce(
            (runId, signal) =>
                new Promise((resolve) => {
                    release = () => {
                        void original(runId, signal).then(resolve);
                    };
                }),
        );
        const { user } = await renderRun(RUN_IDS.running, engine);
        const cancel = screen.getByRole('button', { name: 'Cancel run' });
        cancel.focus();
        await user.keyboard('{Enter}');
        expect(await screen.findByText('Cancelling…')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
        release();
        await waitFor(() => {
            expect(engine.controller.getRun(RUN_IDS.running)?.cancelRequestedAt).not.toBeNull();
        });
        expect(await within(statusFact()).findByText('Cancelling…')).toBeDefined();
    });

    it('rolls back and reports a refused cancel', async () => {
        const engine = createRunsEngine();
        engine.spies.cancel.mockImplementationOnce(() => problemResponse('validation-failed'));
        const { user } = await renderRun(RUN_IDS.running, engine);
        await user.click(screen.getByRole('button', { name: 'Cancel run' }));
        expect(await screen.findByText('"Summarise open pull requests" could not be cancelled.')).toBeDefined();
        expect(await screen.findByRole('button', { name: 'Cancel run' })).toBeDefined();
        expect(screen.getByText('Running')).toBeDefined();
    });

    it('says the run already finished when the engine answers 409 run-finished, and shows its state', async () => {
        const engine = createRunsEngine();
        // The run ends on the engine just as the member clicks: the cancel arrives too late.
        engine.spies.cancel.mockImplementationOnce(() => {
            engine.controller.advanceRun(RUN_IDS.running);
            return problemResponse('run-finished');
        });
        const { user } = await renderRun(RUN_IDS.running, engine);
        await user.click(screen.getByRole('button', { name: 'Cancel run' }));
        expect(
            await screen.findByText(
                '"Summarise open pull requests" had already finished, so there was nothing to cancel.',
            ),
        ).toBeDefined();
        expect(await screen.findByText('Completed')).toBeDefined();
        expect(screen.queryByText('Cancelling…')).toBeNull();
    });

    it('retries a failed run and opens the new one', async () => {
        const { user, router, engine } = await renderRun(RUN_IDS.failed);
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => {
            expect(router.state.location.pathname).not.toBe(`/runs/${RUN_IDS.failed}`);
        });
        expect(router.state.location.pathname).toMatch(/^\/runs\//);
        expect(await screen.findByText('Retrying "Write the weekly report" as a new run.')).toBeDefined();
        expect(await within(statusFact()).findByText('Queued')).toBeDefined();
        expect(screen.getByRole('link', { name: 'The failed run' }).getAttribute('href')).toBe(
            `/runs/${RUN_IDS.failed}`,
        );
        expect(engine.spies.retry).toHaveBeenCalledTimes(1);
    });

    it('offers neither cancel nor retry without runs.control', async () => {
        const engine = createRunsEngine({ permissions: allBut('runs.control') });
        await renderRun(RUN_IDS.running, engine);
        expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
        renderWithProviders({ path: `/runs/${RUN_IDS.failed}`, engineApi: engine.client });
        await screen.findByRole('heading', { level: 1, name: 'Write the weekly report' });
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    it('says "not allowed" when the engine refuses with 403', async () => {
        const engine = createRunsEngine();
        engine.spies.retry.mockImplementationOnce(() => problemResponse('forbidden'));
        const { user } = await renderRun(RUN_IDS.failed, engine);
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByText(/not allowed/i)).toBeDefined();
    });
});
