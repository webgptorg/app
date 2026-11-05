// Flow 11: the main pages pass axe (no serious or critical violation) in light and dark mode, Czech replaces the
// visible text and `<html lang>`, and nothing overflows sideways at 360 px.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { apiList, required, settled } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

const MAIN_PAGES = [
    '/',
    '/agents',
    '/runs',
    '/files',
    '/triggers',
    '/integrations',
    '/security',
    '/secrets',
    '/audit',
    '/members',
    '/settings',
];

async function mainPages(page: Page): Promise<readonly string[]> {
    const agent = required((await apiList<{ id: string }>(page, '/agents'))[0], 'agent');
    return [...MAIN_PAGES, `/agents/${agent.id}`, `/agents/${agent.id}/chat`, `/chats`, `/agents/${agent.id}/book`];
}

async function open(page: Page, url: string): Promise<void> {
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await settled(page);
}

async function seriousViolations(page: Page): Promise<readonly string[]> {
    const { violations } = await new AxeBuilder({ page }).analyze();
    return violations
        .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

for (const scheme of ['light', 'dark'] as const) {
    test(`the main pages have no serious accessibility violations in ${scheme} mode`, async ({
        page,
        signIn,
        appUrl,
    }) => {
        test.setTimeout(120_000);
        await page.emulateMedia({ colorScheme: scheme });
        await signIn();
        await page.goto(appUrl('/'));
        for (const path of await mainPages(page)) {
            await open(page, appUrl(path));
            expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
                scheme === 'dark',
            );
            expect(await seriousViolations(page), path).toEqual([]);
        }
    });
}

test('switching to Czech changes the visible text and <html lang>', async ({ page, signIn, appUrl }) => {
    await signIn();
    await page.goto(appUrl('/settings'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Agents', exact: true })).toBeVisible();

    await page.getByRole('combobox', { name: 'Language' }).selectOption('cs');
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
    await expect(nav.getByRole('link', { name: 'Agents', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
    expect(await seriousViolations(page)).toEqual([]);
});

test('the main pages do not overflow sideways at 360 px', async ({ page, signIn, appUrl }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 360, height: 740 });
    await signIn();
    await page.goto(appUrl('/'));
    for (const path of await mainPages(page)) {
        await open(page, appUrl(path));
        const overflow = await page.evaluate(
            () =>
                new Promise<number>((resolve) => {
                    requestAnimationFrame(() => {
                        resolve(document.documentElement.scrollWidth - document.documentElement.clientWidth);
                    });
                }),
        );
        expect(overflow, path).toBeLessThanOrEqual(0);
    }
});
