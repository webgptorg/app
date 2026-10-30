// A member who lost a device signs out everywhere else from the sessions page: the other browser's session ends at the
// gateway, so its next page load lands on sign-in, while this one stays signed in.
import { SIGN_IN_PATH } from '@ptbk/engine-api';

import { expect, OWNER, test } from '../../src/ui-fixtures.ts';

test('signing out the other sessions ends them and keeps this one', async ({
    page,
    browser,
    engine,
    signIn,
    appUrl,
}) => {
    test.setTimeout(60_000);
    const other = await browser.newContext();
    try {
        const cookie = await engine.session(OWNER);
        await other.addCookies([{ ...cookie, url: appUrl('/'), secure: true, httpOnly: true, sameSite: 'Strict' }]);
        const lostDevice = await other.newPage();
        await lostDevice.goto(appUrl('/agents'));
        await expect(lostDevice.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();

        await signIn();
        await page.goto(appUrl('/security/sessions'));
        await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
        const list = page.getByRole('region', { name: "Where you're signed in" });
        await expect(list.getByRole('listitem')).toHaveCount(2);
        await expect(list.getByRole('listitem').filter({ hasText: 'This device' })).toHaveCount(1);

        await page.getByRole('button', { name: 'Sign out other sessions' }).click();
        await page
            .getByRole('dialog', { name: 'Sign out 1 other session?' })
            .getByRole('button', { name: 'Sign out other sessions' })
            .click();
        await expect(page.getByText('Signed out 1 other session')).toBeVisible();
        await expect(list.getByRole('listitem')).toHaveCount(1);
        await expect(list.getByText("You're signed in only on this device.")).toBeVisible();

        await lostDevice.reload();
        expect(new URL(lostDevice.url()).pathname).toBe(SIGN_IN_PATH);
        await page.reload();
        await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
    } finally {
        await other.close();
    }
});
