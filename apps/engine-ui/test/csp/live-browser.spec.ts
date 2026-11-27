import type { Page } from '@playwright/test';

import { routeFakeEngineApi } from './fake-engine-api.ts';
import { expect, expectCleanPage, test } from './fixtures.ts';

const SITE = 'https://shop.example';
const HOSTILE_MESSAGE = '<img src=x onerror=alert(1)> <script>alert(1)</script> I hit a login wall.';

/** CSP and Trusted Types reports from the bundle's listener and the browser's console, after the interactions. */
async function violations(page: Page, consoleErrors: readonly string[]): Promise<unknown[]> {
    return [...(await page.evaluate(() => window.__ptbkCspViolations ?? [])), ...consoleErrors];
}

function recordConsoleErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
    });
    return errors;
}

/** Whether the canvas holds a drawn frame: some pixel is not transparent. */
function canvasHasPixels(page: Page): Promise<boolean> {
    return page
        .getByRole('application')
        .or(page.getByRole('img', { name: /^Live view/ }))
        .evaluate((element) => {
            if (!(element instanceof HTMLCanvasElement)) return false;
            const pixels = element.getContext('2d')?.getImageData(0, 0, element.width, element.height).data ?? [];
            return Array.prototype.some.call(pixels, (value: number, index: number) => index % 4 === 3 && value > 0);
        });
}

test.describe('the live browser under the engine CSP', () => {
    test('takes over a tab from a help request, draws its frames, types and hands it back', async ({ page, visit }) => {
        const consoleErrors = recordConsoleErrors(page);
        const engine = await routeFakeEngineApi(page, { liveBrowser: true });
        const tab = engine.openAgentTab({ agentId: 'ada', origin: SITE });
        engine.requestBrowserHelp(tab.id, { reason: 'login', message: HOSTILE_MESSAGE });

        const home = await visit('/');
        expectCleanPage(home);
        const item = page.getByRole('listitem').filter({ hasText: 'Ada needs you to sign in' });
        await expect(item.getByText(HOSTILE_MESSAGE)).toBeVisible();
        await expect(page.locator('main img[src="x"], main script')).toHaveCount(0);
        await item.getByRole('button', { name: 'Take over' }).click();

        await expect(page.getByRole('heading', { level: 1, name: "Ada's browser" })).toBeVisible();
        await expect(page.getByText("You're in control")).toBeVisible();
        const screen = page.getByRole('application', { name: 'Live view of the tab on shop.example' });
        await expect(screen).toBeVisible();
        await expect.poll(() => canvasHasPixels(page)).toBe(true);
        expect(engine.getBrowserTab(tab.id)?.agentState).toBe('paused');

        await screen.click({ position: { x: 40, y: 30 } });
        await page.keyboard.type('ab');
        await page.keyboard.press('Enter');
        await expect.poll(() => engine.getBrowserTab(tab.id)?.participants).toBe(1);

        // A reload reattaches to the same session, and the viewer meets every route's bar.
        const viewer = await visit(new URL(page.url()).pathname);
        expectCleanPage(viewer);
        await expect(page.getByText("You're in control")).toBeVisible();
        await expect.poll(() => canvasHasPixels(page)).toBe(true);

        await page.getByRole('button', { name: 'Hand back to agent' }).click();
        await expect(page.getByText('Watching', { exact: true })).toBeVisible();
        expect(engine.getBrowserTab(tab.id)?.agentState).toBe('working');

        await page.getByRole('button', { name: 'More browser actions' }).click();
        await page.getByRole('menuitem', { name: 'Stop watching' }).click();
        await expect(page.getByText('The session ended.')).toBeVisible();

        expect(await violations(page, consoleErrors)).toEqual([]);
    });

    test('shows a blocked page without its frames and keeps the shell indicator elsewhere', async ({ page, visit }) => {
        const consoleErrors = recordConsoleErrors(page);
        const engine = await routeFakeEngineApi(page, { liveBrowser: true });
        const tab = engine.openAgentTab({ agentId: 'ada', origin: SITE });
        await visit('/');
        const opened = await page.evaluate(async (tabId) => {
            const response = await fetch(`/api/v1/browser-tabs/${tabId}/control`, { method: 'POST' });
            return (await response.json()) as { id: string };
        }, tab.id);
        await visit(`/browser/${opened.id}`);
        await expect(page.getByText("You're in control")).toBeVisible();
        engine.navigateBrowserTab(tab.id, { kind: 'secret-page' });
        await expect(page.getByText('Page hidden')).toBeVisible();
        await expect(page.getByText(/a page with secrets, which is never shown/)).toBeVisible();

        await page.getByRole('link', { name: 'Home' }).first().click();
        const bar = page.getByRole('status').filter({ hasText: "You're controlling the agent's browser" });
        await expect(bar).toBeVisible();
        await bar.getByRole('button', { name: 'End' }).click();
        await expect(bar).toHaveCount(0);
        expect(engine.getBrowserTab(tab.id)?.agentState).toBe('working');

        expect(await violations(page, consoleErrors)).toEqual([]);
    });
});
