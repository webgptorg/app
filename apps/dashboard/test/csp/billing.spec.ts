import { expect, expectNoBrowserErrors, outboxLink, test, uniqueEmail } from './fixtures.ts';

// The built app with the dev config's fake billing provider: Checkout completes at once and comes back to /billing.
test('subscribe through the fake Checkout and open the portal under the production CSP', async ({
    page,
    authenticators,
    browserReport,
    checkScreen,
}) => {
    await authenticators.add();
    const email = uniqueEmail('billing');
    await page.goto('/signup');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send the link' }).click();
    await page.goto(await outboxLink(page.request, email, 'signup-link'));
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();

    await page.getByRole('link', { name: 'Billing' }).click();
    await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
    await checkScreen('/billing');

    await page.getByRole('button', { name: 'Subscribe to standard' }).click();
    await expect(page).toHaveURL(/\/billing\?checkout=success$/);
    await expect(page.getByText('Thank you, your subscription is starting')).toBeVisible();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    await checkScreen('/billing subscribed');

    await page.getByRole('button', { name: 'Manage billing' }).click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();

    expectNoBrowserErrors(browserReport());
});
