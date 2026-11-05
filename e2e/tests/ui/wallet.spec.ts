// Flow 7: Wallet passwords are write-only. Add a login with a random canary password, update it with a second one,
// answer an agent's request and remove the login: neither canary ever comes back in the page, a response, browser
// storage or the console.
import type { Request } from '@playwright/test';

import { expectCanariesAbsent, newCanary } from '../../src/canary.ts';
import { addWalletLogin } from '../../src/ui-app.ts';
import { expect, need, test } from '../../src/ui-fixtures.ts';

test('a login is added, updated and removed without its password ever coming back', async ({
    page,
    context,
    signIn,
    appUrl,
    responses,
    guard,
}) => {
    test.setTimeout(60_000);
    const sent: Request[] = [];
    context.on('request', (request) => {
        if (request.method() !== 'GET') sent.push(request);
    });
    const site = `e2e-${crypto.randomUUID().slice(0, 8)}.example`;
    const label = `${site} · ca…@example.com`;
    const [first, second] = [newCanary(), newCanary()];
    await signIn();
    await page.goto(appUrl('/wallet'));
    await expect(page.getByRole('heading', { level: 1, name: 'Wallet' })).toBeVisible();

    await addWalletLogin(page, site, 'canary@example.com', first);
    const logins = page.getByRole('region', { name: 'Saved logins' });
    const row = logins.getByRole('listitem').filter({ hasText: label });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Not checked yet');

    await row.getByRole('button', { name: 'Update' }).click();
    const update = page.getByRole('dialog', { name: `Update login for ${site}` });
    await expect(update.getByRole('textbox', { name: /^Username or email/ })).toHaveValue('canary@example.com');
    const password = update.getByLabel(/^Password/);
    await password.fill(second);
    await expect(password).toHaveAttribute('type', 'password');
    await update.getByRole('button', { name: 'Save login' }).click();
    // The toast of the first save may still be up.
    await expect(page.getByText(`Login for ${site} saved.`).last()).toBeVisible();
    await expect(update).toHaveCount(0);

    await row.getByRole('button', { name: `More for ${label}` }).click();
    await page.getByRole('menuitem', { name: 'Remove login' }).click();
    await page
        .getByRole('dialog', { name: `Remove ${label}?` })
        .getByRole('button', { name: 'Remove login' })
        .click();
    await expect(page.getByText(`${label} removed.`)).toBeVisible();
    await expect(row).toHaveCount(0);

    // Positive control: each password did travel to the engine, once, in the request that set it.
    for (const canary of [first, second]) {
        expect(sent.filter((request) => request.postData()?.includes(canary) === true)).toHaveLength(1);
    }
    await expectCanariesAbsent([first, second], {
        page,
        responses,
        consoleMessages: guard.consoleMessages,
        seenInResponses: label,
    });
});

test('an agent request is marked as seen, keeps waiting, and is rejected', async ({ page, engine, signIn, appUrl }) => {
    const walletRequest = need(engine, 'walletRequest');
    const site = `asked-${crypto.randomUUID().slice(0, 8)}.example`;
    await walletRequest(`https://${site}`);
    await signIn();
    await page.goto(appUrl('/wallet'));
    const requests = page.getByRole('region', { name: 'Agents are waiting' });
    const request = requests.getByRole('listitem').filter({ hasText: `needs a login for ${site}` });
    await expect(request).toBeVisible();
    await request.getByRole('button', { name: 'Mark as seen' }).click();
    await expect(request).toContainText('Seen');
    await page.reload();
    await expect(request).toContainText('Seen');

    await request.getByRole('button', { name: `More for the ${site} request` }).click();
    await page.getByRole('menuitem', { name: /^Reject request/ }).click();
    await expect(page.getByText(`Request for ${site} rejected.`)).toBeVisible();
    await expect(request).toHaveCount(0);
});
