// Flow 13: runs. A scripted run progresses live in the timeline and its detail; a finished run shows usage, cost and a
// project change with its files and the truncated diff; a running run is cancelled and a failed one retried as a new,
// linked run; a member without runs.control is offered neither and the engine refuses both.
import { PERMISSIONS } from '@ptbk/engine-api';
import type { Page } from '@playwright/test';

import { apiCall, apiGet, apiList, eventsConnected, factValue, required } from '../../src/ui-app.ts';
import { expect, need, test } from '../../src/ui-fixtures.ts';

interface Run {
    readonly id: string;
    readonly agentId: string;
    readonly status: string;
}

interface ProjectChange {
    readonly projectName: string;
    readonly diffTruncated: boolean;
    readonly changedFiles: readonly { readonly path: string }[];
}

/** A finished run with usage and a commit whose diff the engine truncated (the seed has one). */
async function runWithTruncatedDiff(page: Page): Promise<{ runId: string; change: ProjectChange }> {
    const completed = await apiList<Run>(page, '/runs?status=completed');
    for (const run of completed) {
        const detail = await apiGet<{ usage: unknown; outputs: { projectChanges: ProjectChange[] } }>(
            page,
            `/runs/${run.id}`,
        );
        const change = detail.outputs.projectChanges.find((candidate) => candidate.diffTruncated);
        if (change !== undefined && detail.usage !== null) return { runId: run.id, change };
    }
    throw new Error('the seed has no completed run with a truncated diff');
}

test('a scripted run progresses live in the timeline and in its detail', async ({ page, engine, signIn, appUrl }) => {
    test.setTimeout(60_000);
    const scriptRun = need(engine, 'scriptRun');
    const advanceTime = need(engine, 'advanceTime');
    await signIn();
    const live = eventsConnected(page);
    await page.goto(appUrl('/runs'));
    await expect(page.getByRole('table', { name: 'Runs' }).getByRole('link').first()).toBeVisible();
    await live;
    const agent = required((await apiList<{ id: string }>(page, '/agents'))[0], 'agent');
    const { runId } = await scriptRun({
        agentId: agent.id,
        outcome: 'completed',
        steps: [{ text: 'Collect the open issues', toolName: 'github.list_issues' }, { text: 'Write the summary' }],
    });

    const row = page.getByRole('row').filter({ has: page.locator(`a[href="/runs/${runId}"]`) });
    await expect(row).toContainText('Queued');
    await advanceTime(1_000);
    await expect(row).toContainText('Running');

    await row.locator(`a[href="/runs/${runId}"]`).click();
    const status = factValue(page.locator('main'), 'Status');
    await expect(status).toContainText('Running');
    // One simulated second per poll, until the UI, updated by events alone, shows the run finished.
    await expect
        .poll(
            async () => {
                await advanceTime(1_000);
                return status.textContent();
            },
            { intervals: [250], timeout: 30_000 },
        )
        .toContain('Completed');
    await expect(status).toContainText('Completed');
    await expect(page.getByRole('region', { name: 'Steps' }).getByText('Write the summary')).toBeVisible();
    await expect(
        page.getByRole('region', { name: 'Tool calls' }).getByText('github.list_issues').first(),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Usage and cost' })).toBeVisible();
});

test('a finished run shows usage, cost and the project change with the truncated diff', async ({
    page,
    signIn,
    appUrl,
}) => {
    test.setTimeout(60_000);
    await signIn();
    await page.goto(appUrl('/runs'));
    const { runId, change } = await runWithTruncatedDiff(page);
    await page.goto(appUrl(`/runs/${runId}`));
    const usage = page.getByRole('region', { name: 'Usage and cost' });
    await expect(factValue(usage, 'Input tokens')).toHaveText(/\d/);
    await expect(factValue(usage, 'Cost')).toHaveText(/\$/);
    const outputs = page.getByRole('region', { name: 'Outputs' });
    await expect(outputs.getByRole('heading', { name: `Changes in ${change.projectName}` })).toBeVisible();
    const firstFile = required(change.changedFiles[0], 'changed file');
    await expect(outputs.getByRole('table', { name: `Files changed in ${change.projectName}` })).toContainText(
        firstFile.path,
    );
    await expect(outputs.getByText(/The engine truncated this diff/)).toBeVisible();
    await expect(outputs.getByRole('region', { name: `Diff of ${change.projectName}` })).toBeVisible();
});

test('a running run is cancelled and a failed one retried as a new linked run', async ({
    page,
    engine,
    signIn,
    appUrl,
}) => {
    test.setTimeout(60_000);
    const scriptRun = need(engine, 'scriptRun');
    const advanceTime = need(engine, 'advanceTime');
    await signIn();
    await page.goto(appUrl('/runs'));
    const agent = required((await apiList<{ id: string }>(page, '/agents'))[0], 'agent');
    const { runId } = await scriptRun({
        agentId: agent.id,
        outcome: 'completed',
        steps: Array.from({ length: 10 }, (_, index) => ({ text: `Step ${String(index + 1)}` })),
    });
    await advanceTime(1_000);
    await page.goto(appUrl(`/runs/${runId}`));
    const status = factValue(page.locator('main'), 'Status');
    await expect(status).toContainText('Running');
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.getByText('Cancelling…').first()).toBeVisible();
    await advanceTime(2_000);
    await expect(status).toContainText('Cancelled');
    expect((await apiGet<Run>(page, `/runs/${runId}`)).status).toBe('cancelled');

    const failed = required((await apiList<Run>(page, '/runs?status=failed'))[0], 'failed run');
    await page.goto(appUrl(`/runs/${failed.id}`));
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText(/as a new run\.$/)).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(`/runs/${failed.id}$`));
    const retryOf = factValue(page.locator('main'), 'Retry of');
    await expect(retryOf.getByRole('link', { name: 'The failed run' })).toHaveAttribute('href', `/runs/${failed.id}`);
    const retried = required(/\/runs\/([^/?#]+)$/.exec(page.url())?.[1], 'new run ID');
    expect((await apiGet<{ retryOf: string | null }>(page, `/runs/${retried}`)).retryOf).toBe(failed.id);
});

test('a member without runs.control is offered neither cancel nor retry, and the engine refuses both', async ({
    page,
    signIn,
    appUrl,
}) => {
    await signIn({ kind: 'member', permissions: PERMISSIONS.filter((permission) => permission !== 'runs.control') });
    await page.goto(appUrl('/runs'));
    const running = required((await apiList<Run>(page, '/runs?status=running'))[0], 'running run');
    const failed = required((await apiList<Run>(page, '/runs?status=failed'))[0], 'failed run');

    await page.goto(appUrl(`/runs/${running.id}`));
    await expect(factValue(page.locator('main'), 'Status')).toContainText('Running');
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
    await page.goto(appUrl(`/runs/${failed.id}`));
    await expect(factValue(page.locator('main'), 'Status')).toContainText('Failed');
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);

    expect((await apiCall(page, 'POST', `/runs/${running.id}/cancel`)).status).toBe(403);
    expect((await apiCall(page, 'POST', `/runs/${failed.id}/retry`)).status).toBe(403);
});
