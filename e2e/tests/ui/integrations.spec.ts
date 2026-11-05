// Flow 16: an MCP server that names a secret, with no field for its value, and a connection check that shows the
// engine's verdict.
import { uniqueName } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

test('adds an MCP server referencing a secret by name and checks its connection', async ({ page, signIn, appUrl }) => {
    test.setTimeout(60_000);
    // A named tool secret the mock seeds as available, so the connection check gets past the missing-secret state.
    const secretName = 'OPENAI_API_KEY';
    const name = uniqueName('Search');
    await signIn();
    await page.goto(appUrl('/integrations'));
    await page.getByRole('button', { name: 'Add integration' }).click();
    await page.getByRole('menuitem', { name: 'MCP server' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add MCP server' });
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await dialog.getByRole('textbox', { name: /^Name/ }).fill(name);
    // Only the engine would ever contact it; the browser never does (the page guard fails on any foreign request).
    await dialog.getByRole('textbox', { name: /^Server URL/ }).fill('https://mcp.example.com/mcp');
    await dialog.getByRole('textbox', { name: /^Secrets it uses/ }).fill(secretName);
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText(`${name} added.`)).toBeVisible();

    await page.getByRole('table').getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Secrets it uses' })).toContainText(secretName);
    await page.getByRole('button', { name: 'Check connection' }).click();
    await expect(
        page.getByText(new RegExp(`^${name} (connected|still needs attention|could not connect|is disabled).*\\.$`)),
    ).toBeVisible();
    await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
});
