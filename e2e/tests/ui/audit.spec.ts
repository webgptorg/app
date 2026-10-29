// Flow 8: what the owner did in the flows above shows up in the audit log, and its filters by action and by target
// work and stay in the URL.
import { apiList, createSecret, openRowMenu, required, uniqueName } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

interface Agent {
    readonly id: string;
    readonly name: string;
    readonly visibility: string;
}

test('the actions taken in the UI are audited and the filters find them', async ({ page, signIn, appUrl }) => {
    test.setTimeout(60_000);
    const secretName = uniqueName('E2E_AUDIT').replace(' ', '_').toUpperCase();
    await signIn();
    await page.goto(appUrl('/agents'));
    const agent = required(
        (await apiList<Agent>(page, '/agents')).find((candidate) => candidate.visibility === 'private'),
        'private agent',
    );
    await (await openRowMenu(page, agent.name)).getByRole('menuitem', { name: 'Make public' }).click();
    await page
        .getByRole('dialog', { name: `Make ${agent.name} public?` })
        .getByRole('button', { name: 'Make public' })
        .click();
    await expect(page.getByText(`${agent.name} is now Public`)).toBeVisible();

    await page.goto(appUrl('/secrets'));
    await createSecret(page, secretName, `audit-${crypto.randomUUID()}`);

    await page.goto(appUrl('/audit'));
    await expect(page.getByRole('button', { name: /^Chain verified / })).toBeVisible();
    const table = page.getByRole('table');

    await page.getByRole('combobox', { name: 'Action' }).selectOption('secret.create');
    await expect(page).toHaveURL((url) => url.searchParams.get('action') === 'secret.create');
    await expect(table.getByText(secretName, { exact: true })).toBeVisible();
    await expect(table.getByText('Secret created', { exact: true }).first()).toBeVisible();
    await expect(table.getByText('Agent updated', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has('action'));
    await page.getByRole('button', { name: 'More filters' }).click();
    await page.getByRole('combobox', { name: 'Target type' }).selectOption('agent');
    await page.getByRole('textbox', { name: 'Target ID' }).fill(agent.id);
    await expect(page).toHaveURL(
        (url) => url.searchParams.get('targetKind') === 'agent' && url.searchParams.get('targetId') === agent.id,
    );
    await expect(table.getByText('Agent updated', { exact: true }).first()).toBeVisible();
    await expect(table.getByText(secretName, { exact: true })).toHaveCount(0);

    // The filters come back from the URL alone.
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Target type' })).toHaveValue('agent');
    await expect(table.getByText('Agent updated', { exact: true }).first()).toBeVisible();
});
