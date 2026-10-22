// Flow 3: the create-agent wizard end to end: brief, book, a small knowledge file, a test chat with a streamed reply,
// done; the new agent is then in the list.
import { uniqueName } from '../../src/ui-app.ts';
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
    await page.getByRole('button', { name: 'Start a test chat' }).click();
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('How much is a coffee?');
    await composer.press('Enter');
    const history = page.getByRole('region', { name: 'Messages' });
    // Streamed: the reply shows while it is still being written, then settles.
    await expect(history.getByText('Replying…')).toBeVisible();
    await expect(page.getByText(`${name} replied`)).toBeAttached({ timeout: 60_000 });
    await expect(history.getByText('Replying…')).toHaveCount(0);
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { level: 2, name: 'Your agent is ready' })).toBeVisible();
    await page.getByRole('link', { name: 'Open agent' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Agents' }).getByRole('link', { name, exact: true })).toBeVisible();
});
