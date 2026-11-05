// Tasks: the engine's inventory, read-only. The owner finds the recurring digest among current and upcoming work, reads
// its occurrence history, follows a run and comes back to the task from the run; a dependant shows what blocks it, and
// the page offers chat instead of task buttons.
import { expect, test } from '../../src/ui-fixtures.ts';

test('the owner reads a recurring task, its occurrences and runs, and is sent to chat to change it', async ({
    page,
    signIn,
    appUrl,
}) => {
    await signIn();
    await page.goto(appUrl('/tasks'));
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    const now = page.getByRole('region', { name: 'Now' });
    await expect(now.getByRole('link', { name: /^Launch the customer newsletter/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Coming up' }).getByText('Engine', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: /^Weekly analytics digest/ }).click();
    const history = page.getByRole('region', { name: 'History' });
    await expect(history.getByText('#3 · Retry')).toBeVisible();
    await expect(history.getByText('The analytics API answered 503.')).toBeVisible();
    await expect(page.getByRole('button', { name: /cancel|retry|delete/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Discuss in chat' })).toBeVisible();

    await history
        .getByRole('listitem')
        .filter({ hasText: '#3 · Retry' })
        .getByRole('link', { name: 'Open run' })
        .click();
    await page.getByRole('link', { name: /^Weekly analytics digest/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^Weekly analytics digest/ })).toBeVisible();

    await page.goto(appUrl('/tasks/task-send-first-issue'));
    const related = page.getByRole('region', { name: 'Related' });
    await expect(related.getByText('Not done yet')).toBeVisible();
    await expect(related.getByRole('link', { name: /^Launch the customer newsletter/ }).first()).toBeVisible();
});
