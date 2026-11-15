// Flow 12: home and activity. With engine time paused, a scripted run's start and finish reach the live feed without a
// reload; the command palette navigates to an agent and to a run by keyboard; the owner's Chatter-first home has the
// activity feed beside it, a member's does not.
import type { Locator, Page } from '@playwright/test';

import { apiGet, apiList, eventsConnected, required } from '../../src/ui-app.ts';
import { expect, need, test } from '../../src/ui-fixtures.ts';

const PALETTE = 'Search agents, runs, pages and commands';

interface Agent {
    readonly id: string;
    readonly name: string;
}

/** Moves the palette's active option to `option` with the arrow keys, then takes it with Enter. */
async function chooseByKeyboard(page: Page, option: Locator): Promise<void> {
    const box = page.getByRole('combobox', { name: PALETTE });
    const id = required((await option.getAttribute('id')) ?? undefined, 'palette option id');
    for (let step = 0; step < 20 && (await box.getAttribute('aria-activedescendant')) !== id; step += 1) {
        await page.keyboard.press('ArrowDown');
    }
    await expect(box).toHaveAttribute('aria-activedescendant', id);
    await page.keyboard.press('Enter');
}

test('the owner sees a Chatter-first home with what waits, what runs and the activity feed', async ({
    page,
    signIn,
    appUrl,
}) => {
    await signIn();
    await page.goto(appUrl('/'));
    const me = await apiGet<{ displayName: string }>(page, '/me');
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(`, ${me.displayName}$`) })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Ask Chatter' })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Needs you/ })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Working now/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Recent chats' })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Recent activity/ })).toBeVisible();
});

test('a member sees their own home, without the activity feed', async ({ page, signIn, appUrl }) => {
    await signIn({ kind: 'member', role: 'member' });
    await page.goto(appUrl('/'));
    await expect(page.getByRole('region', { name: 'Recent chats' })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Working now/ })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Recent activity/ })).toHaveCount(0);
});

test("a scripted run's start and finish appear in the live activity feed without a reload", async ({
    page,
    engine,
    signIn,
    appUrl,
}) => {
    test.setTimeout(60_000);
    const scriptRun = need(engine, 'scriptRun');
    const advanceTime = need(engine, 'advanceTime');
    await signIn();
    const live = eventsConnected(page);
    await page.goto(appUrl('/'));
    const feed = page.getByRole('region', { name: /^Recent activity/ });
    await expect(feed).toBeVisible();
    await live;
    const agent = required((await apiList<Agent>(page, '/agents'))[0], 'agent');
    let navigations = 0;
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
    });

    await scriptRun({
        agentId: agent.id,
        outcome: 'completed',
        steps: [{ text: 'Read the inbox' }, { text: 'Reply' }],
    });
    await advanceTime(2_000);
    // Each run event is a row: the run as a chip and its outcome as a pill.
    const runRows = feed.getByRole('listitem').filter({ hasText: 'API run' });
    await expect(runRows.filter({ hasText: 'Running' }).first()).toBeVisible();
    await advanceTime(30_000);
    await expect(runRows.filter({ hasText: 'Completed' }).first()).toBeVisible();
    expect(navigations).toBe(0);
});

test('the command palette goes to an agent and to a run by keyboard', async ({ page, signIn, appUrl }) => {
    await signIn();
    await page.goto(appUrl('/settings'));
    const agent = required((await apiList<Agent>(page, '/agents'))[0], 'agent');
    const run = required((await apiGet<{ items: { id: string }[] }>(page, '/runs?limit=1')).items[0], 'run');

    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox', { name: PALETTE });
    await expect(box).toBeFocused();
    await box.fill(agent.name);
    await chooseByKeyboard(
        page,
        page
            .getByRole('group', { name: 'Agents' })
            .getByRole('option', { name: new RegExp(`^${agent.name}`) })
            .first(),
    );
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: agent.name })).toBeVisible();

    await page.keyboard.press('Control+k');
    await box.fill(run.id);
    await chooseByKeyboard(page, page.getByRole('group', { name: 'Runs' }).getByRole('option', { name: /^Open run:/ }));
    await expect(page).toHaveURL(new RegExp(`/runs/${run.id}$`));
});
