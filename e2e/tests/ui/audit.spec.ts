// Flow 8: what the owner did in the flows above shows up in the audit log, and its filters by action and by target
// work and stay in the URL.
import { addWalletLogin, apiList, openRowMenu, required } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

interface Agent {
    readonly id: string;
    readonly name: string;
    readonly visibility: string;
}

test('the actions taken in the UI are audited and the filters find them', async ({ page, signIn, appUrl }) => {
    test.setTimeout(60_000);
    const site = `audit-${crypto.randomUUID().slice(0, 8)}.example`;
    await signIn();
    await page.goto(appUrl('/agents'));
    const agent = required(
        (await apiList<Agent>(page, '/agents?origin=content')).find((candidate) => candidate.visibility === 'private'),
        'private agent',
    );
    await (await openRowMenu(page, agent.name)).getByRole('menuitem', { name: 'Make public' }).click();
    await page
        .getByRole('dialog', { name: `Make ${agent.name} public?` })
        .getByRole('button', { name: 'Make public' })
        .click();
    await expect(page.getByText(`${agent.name} is now Public`)).toBeVisible();

    await page.goto(appUrl('/wallet'));
    await addWalletLogin(page, site, 'audit@example.com', `audit-${crypto.randomUUID()}`);

    await page.goto(appUrl('/audit'));
    await expect(page.getByRole('button', { name: /^Chain verified / })).toBeVisible();
    const table = page.getByRole('table');

    await page.getByRole('combobox', { name: 'Action' }).selectOption('wallet.record.save');
    await expect(page).toHaveURL((url) => url.searchParams.get('action') === 'wallet.record.save');
    await expect(table.getByText(`${site} · au…@example.com`, { exact: true })).toBeVisible();
    await expect(table.getByText('Wallet login saved', { exact: true }).first()).toBeVisible();
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
    await expect(table.getByText(`${site} · au…@example.com`, { exact: true })).toHaveCount(0);

    // The filters come back from the URL alone.
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Target type' })).toHaveValue('agent');
    await expect(table.getByText('Agent updated', { exact: true }).first()).toBeVisible();
});
