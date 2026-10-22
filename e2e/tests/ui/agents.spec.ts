// Flow 2: the seeded agents, search, paging, filters in the URL, detail, start and stop, visibility with
// confirmation, delete with the typed name.
import type { Page } from '@playwright/test';

import { apiCall, apiList, openRowMenu, required } from '../../src/ui-app.ts';
import { ALL_CAPABILITIES } from '../../src/engine-target.ts';
import { UI_SEED, expect, need, test } from '../../src/ui-fixtures.ts';

interface Agent {
    readonly id: string;
    readonly name: string;
    readonly visibility: 'public' | 'unlisted' | 'private';
}

async function seededAgents(page: Page): Promise<readonly Agent[]> {
    return apiList<Agent>(page, '/agents');
}

test.beforeEach(async ({ page, signIn, appUrl }) => {
    await signIn();
    await page.goto(appUrl('/agents'));
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
});

test('lists the seeded agents, searches and filters them, and keeps the filters in the URL', async ({
    page,
    appUrl,
}) => {
    const agents = await seededAgents(page);
    expect(agents.length).toBeGreaterThan(1);
    const table = page.getByRole('table', { name: 'Agents' });
    for (const agent of agents) await expect(table.getByRole('link', { name: agent.name, exact: true })).toBeVisible();

    const wanted = required(agents[0], 'agent');
    await page.getByRole('searchbox', { name: 'Search agents' }).fill(wanted.name);
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === wanted.name);
    await expect(table.getByRole('link', { name: wanted.name, exact: true })).toBeVisible();
    for (const other of agents.filter((agent) => !agent.name.toLowerCase().includes(wanted.name.toLowerCase()))) {
        await expect(table.getByRole('link', { name: other.name, exact: true })).toHaveCount(0);
    }

    await page.getByRole('searchbox', { name: 'Search agents' }).fill('');
    await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
    await page.getByRole('combobox', { name: 'Visibility' }).selectOption('private');
    await expect(page).toHaveURL((url) => url.searchParams.get('visibility') === 'private');
    const privateAgents = agents.filter((agent) => agent.visibility === 'private');
    for (const agent of agents) {
        await expect(table.getByRole('link', { name: agent.name, exact: true })).toHaveCount(
            agent.visibility === 'private' ? 1 : 0,
        );
    }

    await page.goto(appUrl('/agents?visibility=private'));
    await expect(page.getByRole('combobox', { name: 'Visibility' })).toHaveValue('private');
    await expect(table.getByRole('link')).toHaveCount(privateAgents.length);
});

test('pages through a fleet larger than one page', async ({ page, engine, appUrl }) => {
    const reset = need(engine, 'reset');
    await reset({ scenario: 'large-fleet', seed: UI_SEED, capabilities: ALL_CAPABILITIES });
    await page.goto(appUrl('/agents'));
    const table = page.getByRole('table', { name: 'Agents' });
    const firstLink = table.getByRole('link').first();
    await expect(firstLink).toBeVisible();
    const firstOnPageOne = await firstLink.textContent();

    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page).toHaveURL((url) => url.searchParams.has('cursor'));
    await expect(firstLink).not.toHaveText(firstOnPageOne ?? '');
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(firstLink).toHaveText(firstOnPageOne ?? '');
});

test('opens an agent, then stops and starts it', async ({ page }) => {
    const agent = required((await seededAgents(page))[0], 'agent');
    await page.getByRole('link', { name: agent.name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: agent.name })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await page.goBack();

    const menu = await openRowMenu(page, agent.name);
    const stop = menu.getByRole('menuitem', { name: 'Stop' });
    if ((await stop.count()) === 0) {
        await menu.getByRole('menuitem', { name: 'Start' }).click();
        await expect(page.getByText(`${agent.name} started`)).toBeVisible();
        await (await openRowMenu(page, agent.name)).getByRole('menuitem', { name: 'Stop' }).click();
    } else await stop.click();
    await expect(page.getByText(`${agent.name} stopped`)).toBeVisible();
    await (await openRowMenu(page, agent.name)).getByRole('menuitem', { name: 'Start' }).click();
    await expect(page.getByText(`${agent.name} started`)).toBeVisible();
});

test('makes an agent public only after confirming', async ({ page }) => {
    const agent = (await seededAgents(page)).find((candidate) => candidate.visibility === 'private');
    expect(agent, 'the seed has a private agent').toBeDefined();
    const { id, name } = required(agent, 'private agent');
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });

    await (await openRowMenu(page, name)).getByRole('menuitem', { name: 'Make public' }).click();
    const dialog = page.getByRole('dialog', { name: `Make ${name} public?` });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByText('Private', { exact: true })).toBeVisible();
    expect((await apiCall<Agent>(page, 'GET', `/agents/${id}`)).body.visibility).toBe('private');

    await (await openRowMenu(page, name)).getByRole('menuitem', { name: 'Make public' }).click();
    await page
        .getByRole('dialog', { name: `Make ${name} public?` })
        .getByRole('button', { name: 'Make public' })
        .click();
    await expect(page.getByText(`${name} is now Public`)).toBeVisible();
    await expect(row.getByText('Public', { exact: true })).toBeVisible();
    expect((await apiCall<Agent>(page, 'GET', `/agents/${id}`)).body.visibility).toBe('public');
});

test('deletes an agent only once its name is typed', async ({ page }) => {
    const { id, name } = required((await seededAgents(page)).at(-1), 'agent');
    await (await openRowMenu(page, name)).getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: `Delete ${name}?` });
    const confirm = dialog.getByRole('button', { name: 'Delete' });
    const phrase = dialog.getByRole('textbox', { name: `Type ${name} to confirm` });
    await expect(confirm).toBeDisabled();
    await phrase.fill(`${name}x`);
    await expect(confirm).toBeDisabled();
    await phrase.fill(name);
    await confirm.click();

    await expect(page.getByText(`${name} deleted`)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Agents' }).getByRole('link', { name, exact: true })).toHaveCount(0);
    const after = await apiCall<{ deletedAt?: string | null }>(page, 'GET', `/agents/${id}`);
    expect(after.status === 404 || typeof after.body.deletedAt === 'string').toBe(true);
});
