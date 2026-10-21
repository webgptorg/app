import { expect, expectNoBrowserErrors, outboxLink, test, uniqueEmail } from './fixtures.ts';

// The built app with the dev config: the `none` plan cannot link engines, the fake Checkout's `standard` plan can.
test('show the upgrade path, then a link code inside the install command, under the production CSP', async ({
    page,
    authenticators,
    browserReport,
    checkScreen,
}) => {
    await authenticators.add();
    const email = uniqueEmail('engines');
    await page.goto('/signup');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send the link' }).click();
    await page.goto(await outboxLink(page.request, email, 'signup-link'));
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();

    await page.getByRole('link', { name: 'Link an engine' }).click();
    await expect(page.getByRole('heading', { name: 'Link an engine', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Create link code' }).click();
    await expect(page.getByRole('link', { name: 'Go to billing' })).toBeVisible();
    await checkScreen('/engines/new not entitled');

    await page.getByRole('link', { name: 'Go to billing' }).click();
    await page.getByRole('button', { name: 'Subscribe to standard' }).click();
    await expect(page).toHaveURL(/\/billing\?checkout=success$/);

    await page.goto('/engines/new');
    await page.getByRole('button', { name: 'Create link code' }).click();
    await expect(page.getByText(/^bun run dev:link [a-z2-7]{26}$/)).toBeVisible();
    await expect(page.getByText(/^Expires in \d+:\d\d$/)).toBeVisible();
    await checkScreen('/engines/new install command');

    expectNoBrowserErrors(browserReport());
});
