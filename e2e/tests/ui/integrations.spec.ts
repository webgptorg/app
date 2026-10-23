// Flow 16: an MCP server that names a secret, whose canary value never comes back, and a connection check that shows
// the engine's verdict.
import { expectCanariesAbsent, newCanary } from '../../src/canary.ts';
import { createSecret, uniqueName } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

test('adds an MCP server referencing a secret by name and checks its connection', async ({
    page,
    signIn,
    appUrl,
    responses,
    guard,
}) => {
    test.setTimeout(60_000);
    const secretName = uniqueName('E2E_MCP').replace(' ', '_').toUpperCase();
    const canary = newCanary();
    const name = uniqueName('Search');
    await signIn();
    await page.goto(appUrl('/secrets'));
    await createSecret(page, secretName, canary);

    await page.goto(appUrl('/integrations'));
    await page.getByRole('button', { name: 'Add MCP server' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add MCP server' });
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await dialog.getByRole('textbox', { name: /^Name/ }).fill(name);
    // Only the engine would ever contact it; the browser never does (the page guard fails on any foreign request).
    await dialog.getByRole('textbox', { name: /^Server URL/ }).fill('https://mcp.example.com/mcp');
    await dialog.getByRole('checkbox', { name: secretName }).check();
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText(`${name} added`)).toBeVisible();

    await page.getByRole('table').getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Secrets it uses' })).toContainText(secretName);
    await page.getByRole('button', { name: 'Check connection' }).click();
    await expect(page.getByText(new RegExp(`^${name}: (Connected|Needs attention|Error|Disabled)$`))).toBeVisible();
    await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();

    await expectCanariesAbsent([canary], {
        page,
        responses,
        consoleMessages: guard.consoleMessages,
        seenInResponses: secretName,
    });
});
