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
    await page.goto('/continue');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await page.goto(await outboxLink(page.request, email, 'signup-link'));
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

    await page.getByRole('link', { name: 'Billing' }).click();
    await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
    await checkScreen('/billing');

    // The dev plan has a trial (D-10), so the fake Checkout starts one.
    await page.getByRole('button', { name: 'Start your 14-day trial of Standard' }).click();
    await expect(page.getByText('Thank you, your subscription is starting')).toBeVisible();
    // Shown once: the page drops the Checkout return from the URL, so a reload does not thank again.
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByText('Trial', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Trial ends on /)).toBeVisible();
    await expect(page.getByText('0 of unlimited')).toBeVisible();
    await checkScreen('/billing subscribed');

    await page.getByRole('button', { name: 'Manage billing' }).click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();

    expectNoBrowserErrors(browserReport());
});
