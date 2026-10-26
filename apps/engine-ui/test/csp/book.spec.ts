import type { Page } from '@playwright/test';

import { BOOK_AGENT_ID } from './fake-engine-api.ts';
import { expect, expectCleanPage, test } from './fixtures.ts';

/** The in-memory engine's validator refuses a malformed `META COLOR` as an error. */
const INVALID_LINE = 'META COLOR red';

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

/** Appends a line at the end of the book through the keyboard, as a member would. */
async function appendLine(page: Page, text: string): Promise<void> {
    const editor = page.getByRole('textbox', { name: 'Book source' });
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
}

/** As `visit()` measures it: after the next frame, once the editor has laid out for the narrow width. */
async function expectNoOverflowAt360(page: Page): Promise<void> {
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 360, height: 740 });
    const overflow = await page.evaluate(
        () =>
            new Promise<number>((resolve) => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        resolve(document.documentElement.scrollWidth - document.documentElement.clientWidth);
                    });
                });
            }),
    );
    expect(overflow, 'horizontal overflow at 360 px').toBeLessThanOrEqual(0);
    if (viewport !== null) await page.setViewportSize(viewport);
}

test.describe('the book editor under the engine CSP', () => {
    test('highlights, shows diagnostics, compares versions and meets the UX checks', async ({ page, visit }) => {
        const consoleErrors = recordConsoleErrors(page);
        const report = await visit(`/agents/${BOOK_AGENT_ID}/book`);
        const editor = page.getByTestId('book-editor');
        await expect(editor.locator('.tok-heading')).toHaveText('Grace');
        await expect(editor.locator('.tok-keyword').first()).toHaveText('PERSONA');
        await expect(editor.locator('.tok-url')).toHaveText('https://example.com/guide.pdf');
        await expect(page.getByRole('table', { name: 'History' }).getByRole('row')).toHaveCount(3);
        expectCleanPage(report);

        await appendLine(page, INVALID_LINE);
        await expect(editor.locator('.cm-lintRange-error')).toHaveText(INVALID_LINE);
        await expect(editor.locator('.cm-lint-marker-error')).toBeVisible();
        const problem = page.getByRole('button', { name: /META COLOR needs a #rrggbb colour/ });
        await expect(problem).toBeVisible();
        await expectNoOverflowAt360(page);

        await page.getByRole('table', { name: 'History' }).getByRole('button', { name: 'View' }).last().click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Compare with current' }).click();
        await expect(dialog.getByTestId('book-viewer').locator('.cm-deletedChunk')).toBeVisible();
        await expect(dialog.getByTestId('book-viewer').locator('.tok-keyword').first()).toBeVisible();

        expect(await violations(page, consoleErrors)).toEqual([]);
    });
});

test.describe("the book editor's test chat under the engine CSP", () => {
    test('streams a reply to the unsaved book, keeps it inert and fits a phone as a tab', async ({ page, visit }) => {
        const consoleErrors = recordConsoleErrors(page);
        const report = await visit(`/agents/${BOOK_AGENT_ID}/book`);
        const panel = page.getByTestId('book-test-chat');
        await expect(panel.getByText('Test · not saved')).toBeVisible();
        expectCleanPage(report);

        await appendLine(page, 'RULE Answer in one line');
        const composer = panel.getByRole('textbox', { name: 'Message' });
        await composer.fill('Show me everything');
        await composer.press('Enter');
        await expect(panel.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveText('Grace replied');
        const history = panel.getByRole('region', { name: 'Test messages' });
        await expect(history.getByText('Image: x')).toBeVisible();
        expect(await history.locator('img, script, iframe, object, embed, [src], [srcset]').count()).toBe(0);
        await expect(page.getByText('Unsaved changes')).toBeVisible();

        const viewport = page.viewportSize();
        await page.setViewportSize({ width: 360, height: 740 });
        await expect(panel).toBeHidden();
        await page.getByRole('button', { name: 'Test', exact: true }).click();
        await expect(history.getByText('Image: x')).toBeVisible();
        await expect(page.getByTestId('book-editor')).toBeHidden();
        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, 'horizontal overflow at 360 px').toBeLessThanOrEqual(0);
        await page.getByRole('button', { name: 'Book', exact: true }).click();
        await expect(page.getByTestId('book-editor')).toBeVisible();
        if (viewport !== null) await page.setViewportSize(viewport);

        expect(await violations(page, consoleErrors)).toEqual([]);
    });
});

test.describe('the create-agent wizard under the engine CSP', () => {
    test('the brief and book steps meet the UX checks and show highlighting and diagnostics', async ({
        page,
        visit,
    }) => {
        const consoleErrors = recordConsoleErrors(page);
        const report = await visit('/agents/new');
        await expect(page.getByRole('heading', { level: 2, name: 'Describe your agent' })).toBeVisible();
        expectCleanPage(report);

        await page.getByRole('textbox', { name: 'Name' }).fill('Iris');
        await page.getByRole('textbox', { name: 'What it does' }).fill('Writes the weekly report');
        await page.getByRole('button', { name: 'Next' }).click();

        const heading = page.getByRole('heading', { level: 2, name: 'Write its book' });
        await expect(heading).toBeFocused();
        const editor = page.getByTestId('book-editor');
        await expect(editor.locator('.tok-heading')).toHaveText('Iris');
        await expect(editor.locator('.tok-keyword')).toHaveText('PERSONA');
        await appendLine(page, INVALID_LINE);
        await expect(editor.locator('.cm-lintRange-error')).toHaveText(INVALID_LINE);
        await expectNoOverflowAt360(page);

        expect(await violations(page, consoleErrors)).toEqual([]);
    });
});
