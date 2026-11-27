import { expect, test, uniqueEmail } from '../../src/dashboard.ts';
import { inviteToOrganization, newPerson } from '../../src/team-steps.ts';

// D-33: whoever reaches the dashboard some other way than the invitation link still finds the invitation waiting.

test('an invitation waits on home for someone who signed up from scratch, and joins in one click', async ({
    browser,
    page,
    dashboard,
    dashboardFor,
}) => {
    test.setTimeout(120_000);
    const admin = uniqueEmail('offer-admin');
    await dashboard.signUp(admin);
    const colleague = uniqueEmail('offer-new');
    await inviteToOrganization(page, colleague);

    const person = await newPerson(browser);
    await dashboardFor(person.page).signUp(colleague);
    const offers = person.page.getByRole('list', { name: 'Invitations' });
    await expect(offers.getByText(`${admin} invited you to join them on Promptbook`)).toBeVisible();
    await offers.getByRole('button', { name: 'Join' }).click();
    await expect(person.page.getByRole('heading', { name: "You're in" })).toBeVisible();
    await expect(person.page.getByRole('link', { name: 'Go to the dashboard' })).toBeVisible();
    await person.page.context().close();
});

test('an existing account on a device without its passkey adds one by email and then joins', async ({
    browser,
    page,
    dashboard,
    dashboardFor,
}) => {
    test.setTimeout(120_000);
    const admin = uniqueEmail('offer-admin');
    await dashboard.signUp(admin);
    const colleague = uniqueEmail('offer-existing');
    const laptop = await newPerson(browser);
    await dashboardFor(laptop.page).signUp(colleague);
    await laptop.page.context().close();
    await inviteToOrganization(page, colleague);
    const invitation = await dashboard.emailedLink(colleague, 'team-invite');

    // Another device: its authenticator holds no passkey for the account, so the picker could never help.
    const phone = await newPerson(browser);
    await phone.page.goto(invitation);
    await expect(phone.page.getByRole('button', { name: 'Sign in and join' })).toBeVisible();
    await phone.page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(phone.page.getByText(`Check your inbox at ${colleague}`)).toBeVisible();

    // D-35: the same recovery underneath, worded for joining, and the invitation first once the passkey is added.
    await phone.page.goto(await dashboard.emailedLink(colleague, 'invite-passkey-link'));
    await phone.page.getByRole('button', { name: 'Add a passkey on this device' }).click();
    await expect(phone.page.getByRole('heading', { name: 'Your passkey is ready' })).toBeVisible();
    const offers = phone.page.getByRole('list', { name: 'Invitations' });
    await expect(offers.getByText(`${admin} invited you to join them on Promptbook`)).toBeVisible();
    await offers.getByRole('button', { name: 'Join' }).click();
    await expect(phone.page.getByRole('heading', { name: "You're in" })).toBeVisible();
    await phone.page.context().close();
});
