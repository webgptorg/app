// The owner is pointed to the dashboard to invite someone, and changes a member's role, confirmed by a toast that
// names what changed.
import { openRowMenu } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

test('the owner invites from the dashboard and changes a role', async ({ page, signIn, appUrl }) => {
    test.setTimeout(60_000);
    await signIn();
    await page.goto(appUrl('/members'));
    await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();

    // People are invited in the dashboard: the engine UI never creates an engine invite link.
    await expect(page.getByRole('button', { name: 'Invite member' })).toHaveCount(0);

    const viewer = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Viewer', exact: true }) });
    const name = (await viewer.first().getByRole('cell').first().textContent())?.trim() ?? '';
    expect(name).not.toBe('');
    await (await openRowMenu(page, name)).getByRole('menuitem', { name: 'Change role' }).click();
    const change = page.getByRole('dialog', { name: `Change ${name}'s role` });
    await change.getByRole('combobox', { name: 'Role' }).click();
    await page.getByRole('option', { name: /^Member/ }).click();
    await change.getByRole('button', { name: 'Change role' }).click();
    await expect(page.getByText(`Changed ${name}'s role to Member`)).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('Member');
});
