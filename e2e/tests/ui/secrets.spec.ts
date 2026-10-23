// Flow 7: secrets are write-only. Create with a random canary, replace it with a second one, revoke, delete: neither
// canary ever comes back in the page, a response, browser storage or the console.
import type { Request } from '@playwright/test';

import { expectCanariesAbsent, newCanary } from '../../src/canary.ts';
import { createSecret, openRowMenu, uniqueName } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

test('a secret is created, replaced, revoked and deleted without its value ever coming back', async ({
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
    const name = uniqueName('E2E_CANARY').replace(' ', '_').toUpperCase();
    const [first, second] = [newCanary(), newCanary()];
    await signIn();
    await page.goto(appUrl('/secrets'));
    await expect(page.getByRole('heading', { level: 1, name: 'Secrets' })).toBeVisible();

    await createSecret(page, name, first);
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible();

    await (await openRowMenu(page, name)).getByRole('menuitem', { name: 'Replace value' }).click();
    const replace = page.getByRole('dialog', { name: `Replace the value of ${name}` });
    await replace.getByLabel(/^Value/).fill(second);
    await replace.getByRole('button', { name: 'Replace value' }).click();
    await expect(page.getByText(`Value of ${name} replaced`)).toBeVisible();

    await (await openRowMenu(page, name)).getByRole('menuitem', { name: 'Revoke' }).click();
    await page
        .getByRole('dialog', { name: `Revoke ${name}?` })
        .getByRole('button', { name: 'Revoke' })
        .click();
    await expect(page.getByText(`Secret ${name} revoked`)).toBeVisible();
    await expect(row).toContainText('Revoked');

    await (await openRowMenu(page, name)).getByRole('menuitem', { name: 'Delete' }).click();
    const remove = page.getByRole('dialog', { name: `Delete ${name}?` });
    await remove.getByRole('textbox').fill(name);
    await remove.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(`Secret ${name} deleted`)).toBeVisible();
    await expect(row).toHaveCount(0);

    // Positive control: each value did travel to the engine, once, in the request that set it.
    for (const canary of [first, second]) {
        expect(sent.filter((request) => request.postData()?.includes(canary) === true)).toHaveLength(1);
    }
    await expectCanariesAbsent([first, second], {
        page,
        responses,
        consoleMessages: guard.consoleMessages,
        seenInResponses: name,
    });
});
