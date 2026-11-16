// Flow 3: the create-agent wizard end to end: brief, book, a small knowledge file, a throwaway test chat with a
// streamed reply, then finish on the agent's page; the new agent is then in the list and the test left no chat.
import { apiList, uniqueName } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

test('creates an agent through every wizard step', async ({ page, signIn, appUrl }) => {
    test.setTimeout(90_000);
    const name = uniqueName('Iris');
    await signIn();
    await page.goto(appUrl('/agents/new'));

    await expect(page.getByRole('heading', { level: 2, name: 'Describe your agent' })).toBeVisible();
    await page.getByRole('textbox', { name: /^Name/ }).fill(name);
    await page.getByRole('textbox', { name: /^What it does/ }).fill('Answers questions about the price list.');
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { level: 2, name: 'Write its book' })).toBeVisible();
    await expect(page.getByTestId('book-editor').locator('.tok-heading')).toHaveText(name);
    await page.getByRole('button', { name: 'Create agent' }).click();
    await expect(page.getByText(`${name} created`)).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'Add knowledge' })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
        name: 'prices.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Prices\n\nA coffee costs 3 EUR.\n'),
    });
    await expect(page.getByRole('list', { name: 'Uploads' }).getByText('Uploaded')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { level: 2, name: 'Try it out' })).toBeVisible();
    const panel = page.getByTestId('book-test-chat');
    const composer = panel.getByRole('textbox', { name: 'Message' });
    await composer.fill('How much is a coffee?');
    await composer.press('Enter');
    await expect(panel.getByRole('region', { name: 'Test messages' }).getByText('How much is a coffee?')).toBeVisible();
    await expect(panel.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveText(`${name} replied`, {
        timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Finish', exact: true }).click();

    await expect(page.getByText(`${name} is ready`)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    const agentId = new URL(page.url()).pathname.split('/')[2];
    expect(await apiList(page, `/agents/${String(agentId)}/chats`)).toEqual([]);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Agents', exact: true }).click();
    // The grid, the default view: the new agent is a card among the member's own.
    await expect(
        page.getByRole('list', { name: 'Your agents' }).getByRole('button', { name, exact: true }),
    ).toBeVisible();
});
