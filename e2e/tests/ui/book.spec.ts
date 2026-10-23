// Flow 4: edit an agent's book: an invalid line shows diagnostics, the fix saves as a new version, the history shows
// it, a diff compares versions and an older version is restored.
import type { Page } from '@playwright/test';

import { apiList, required } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

/** The engine's validator refuses a malformed colour as an error. */
const INVALID_LINE = 'META COLOR red';
const VALID_COLOUR = '#3366ff';

async function appendLine(page: Page, text: string): Promise<void> {
    await page.getByRole('textbox', { name: 'Book source' }).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
}

test('diagnoses, saves, lists, compares and restores book versions', async ({ page, signIn, appUrl }) => {
    test.setTimeout(60_000);
    await signIn();
    await page.goto(appUrl('/'));
    const [agent] = await apiList<{ id: string; name: string }>(page, '/agents');
    await page.goto(appUrl(`/agents/${required(agent, 'agent').id}/book`));
    const editor = page.getByTestId('book-editor');
    const history = page.getByRole('table', { name: 'History' });
    await expect(editor.locator('.tok-heading').first()).toBeVisible();
    const versionsBefore = await history.getByRole('row').count();

    await appendLine(page, INVALID_LINE);
    await expect(editor.locator('.cm-lintRange-error')).toHaveText(INVALID_LINE);
    await expect(page.getByRole('button', { name: /META COLOR needs a #rrggbb colour/ })).toBeVisible();

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(VALID_COLOUR);
    await expect(page.getByText('No problems found.')).toBeVisible();
    await expect(editor.locator('.cm-lintRange-error')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Book saved as a new version')).toBeVisible();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(history.getByRole('row')).toHaveCount(versionsBefore + 1);

    // The version before the save: the second newest.
    await history.getByRole('button', { name: 'View' }).nth(1).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Compare with current' }).click();
    await expect(dialog.getByTestId('book-viewer').locator('.cm-deletedChunk')).toBeVisible();
    await dialog.getByRole('button', { name: 'Restore this version' }).click();
    await expect(page.getByText('Version restored as a new version')).toBeVisible();
    await expect(history.getByRole('row')).toHaveCount(versionsBefore + 2);
    await expect(editor).not.toContainText(`META COLOR ${VALID_COLOUR}`);
});
