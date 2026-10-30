// The owner invites someone (the link is shown once and the invite is listed until revoked) and changes a member's
// role, each confirmed by a toast that names what changed.
import { openRowMenu } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

test('the owner creates and revokes an invite and changes a role', async ({ page, signIn, appUrl, engine }) => {
    test.setTimeout(60_000);
    await signIn();
    await page.goto(appUrl('/members'));
    await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();

    await page.getByRole('button', { name: 'Invite member' }).click();
    const form = page.getByRole('dialog', { name: 'Invite a member' });
    await form.getByRole('combobox', { name: 'Role' }).selectOption('member');
    await form.getByRole('button', { name: 'Create invite link' }).click();
    const created = page.getByRole('dialog', { name: 'Invite link created' });
    await expect(created.getByRole('textbox', { name: 'Invite link' })).toHaveValue(
        new RegExp(`^https://${engine.hostname.replaceAll('.', '\\.')}/`),
    );
    await created.getByRole('button', { name: 'Done' }).click();

    const invites = page.getByRole('region', { name: 'Pending invites' });
    await expect(invites.getByText('Invite as Member')).toBeVisible();
    await (await openRowMenu(page, 'Invite as Member')).getByRole('menuitem', { name: 'Revoke invite' }).click();
    await page
        .getByRole('dialog', { name: 'Revoke the invite as Member?' })
        .getByRole('button', { name: 'Revoke invite' })
        .click();
    await expect(page.getByText('Revoked the invite as Member')).toBeVisible();
    await expect(invites).toHaveCount(0);

    const viewer = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Viewer', exact: true }) });
    const name = (await viewer.first().getByRole('cell').first().textContent())?.trim() ?? '';
    expect(name).not.toBe('');
    await (await openRowMenu(page, name)).getByRole('menuitem', { name: 'Change role' }).click();
    const change = page.getByRole('dialog', { name: `Change ${name}'s role` });
    await change.getByRole('combobox', { name: 'Role' }).selectOption('member');
    await change.getByRole('button', { name: 'Change role' }).click();
    await expect(page.getByText(`Changed ${name}'s role to Member`)).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('Member');
});
