// Flow 10: the UI under engine and network faults: a dropped chat stream shows as interrupted, an API 500 shows the
// error state with a retry, a slow tunnel shows skeletons and then the data, and losing relay-a mid-session leaves the
// app usable after a retry.
import { chromium } from '@playwright/test';

import { guardFindings } from '../../src/ui-guard.ts';
import { SKELETON, apiList, required } from '../../src/ui-app.ts';
import { everyRelayServesEngine, launchPreferringRelay } from '../../src/relay-order.ts';
import { RELAYS } from '../../src/stack.ts';
import { expect, installGuard, need, newGuard, test } from '../../src/ui-fixtures.ts';

const RELAY_A = required(
    RELAYS.find((relay) => relay.service === 'relay-a'),
    'relay-a',
);

test('a dropped reply stream shows as interrupted and resumes on retry', async ({ page, engine, signIn, appUrl }) => {
    test.setTimeout(90_000);
    const faults = need(engine, 'faults');
    await signIn();
    await page.goto(appUrl('/'));
    const agent = required((await apiList<{ id: string }>(page, '/agents'))[0], 'agent');
    await faults.set({ dropStreamRate: 1, routes: ['/api/v1/chats/*/messages/*/stream'] });

    await page.goto(appUrl(`/agents/${agent.id}/chat`));
    await page.getByRole('textbox', { name: 'New chat' }).fill('Tell me about the deployment pipeline');
    await page.getByRole('textbox', { name: 'New chat' }).press('Enter');
    const history = page.getByRole('region', { name: 'Messages' });
    await expect(history.getByText('Connection lost')).toBeVisible({ timeout: 30_000 });

    await faults.clear();
    await history.getByRole('button', { name: 'Try again' }).click();
    await expect(history.getByText('Connection lost')).toHaveCount(0, { timeout: 60_000 });
});

test('an API 500 shows the error state with a retry that recovers', async ({ page, engine, signIn, appUrl }) => {
    test.setTimeout(60_000);
    const faults = need(engine, 'faults');
    await signIn();
    await faults.set({ errorRate: 1, errorStatus: 500, routes: ['/api/v1/agents'] });
    await page.goto(appUrl('/agents'));
    const retry = page.getByRole('button', { name: 'Try again' }).first();
    await expect(retry).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/could not be loaded|Something went wrong/).first()).toBeVisible();
    await expect(page.getByRole('table', { name: 'Agents' }).getByRole('link')).toHaveCount(0);

    await faults.clear();
    await retry.click();
    await expect(page.getByRole('table', { name: 'Agents' }).getByRole('link').first()).toBeVisible();
});

test('a slow tunnel shows skeletons, then the data', async ({ page, engine, signIn, appUrl }) => {
    test.setTimeout(90_000);
    const faults = need(engine, 'faults');
    await signIn();
    // Loads the bundle at full speed first: its hashed assets are immutable, so the reload under the slow tunnel
    // waits only for the document and the engine's data.
    await page.goto(appUrl('/runs'));
    await expect(page.getByRole('table').getByRole('link').first()).toBeVisible();
    await faults.set({ slowTunnelBytesPerS: 2_048 });
    await page.reload();
    await expect(page.locator(SKELETON).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('table').getByRole('link').first()).toBeVisible({ timeout: 60_000 });
    await faults.clear();
});

test('losing relay-a mid-session leaves the app usable after a retry', async ({
    engine,
    compose,
    caCertificatePem,
    appUrl,
}) => {
    test.setTimeout(150_000);
    // A browser of its own that tries relay-a first, so the session really runs through the relay that dies.
    const browser = await launchPreferringRelay(chromium, engine.hostname, RELAY_A);
    const guard = newGuard();
    try {
        const context = await browser.newContext();
        await installGuard(context, engine.hostname, guard);
        const cookie = await engine.session({ kind: 'owner' });
        await context.addCookies([{ ...cookie, url: appUrl('/'), secure: true, httpOnly: true, sameSite: 'Strict' }]);
        const page = await context.newPage();
        await page.goto(appUrl('/agents'));
        await expect(page.getByRole('table', { name: 'Agents' }).getByRole('link').first()).toBeVisible();

        await compose.kill(RELAY_A.service);
        await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Runs', exact: true }).click();
        const runs = page.getByRole('table').getByRole('link').first();
        const retry = page.getByRole('button', { name: 'Try again' }).first();
        await expect(runs.or(retry)).toBeVisible({ timeout: 30_000 });
        if (await retry.isVisible()) await retry.click();
        await expect(runs).toBeVisible({ timeout: 30_000 });
        await page.reload();
        await expect(runs).toBeVisible({ timeout: 30_000 });
        await context.close();
    } finally {
        await browser.close();
        await compose.start(RELAY_A.service);
        await expect
            .poll(() => everyRelayServesEngine(engine.hostname, caCertificatePem), {
                intervals: [500],
                timeout: 90_000,
            })
            .toBe(true);
    }
    expect(guardFindings(guard)).toEqual([]);
});
