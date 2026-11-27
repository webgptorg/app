import type { ComposeControl } from '../../src/compose.ts';
import { expect, test, uniqueEmail } from '../../src/dashboard.ts';
import { inviteToOrganization, newPerson } from '../../src/team-steps.ts';

// D-31: an invitation link works once, for its own address, for 7 days. What a person sees when it does not.

const NO_LONGER_VALID = 'This invitation link is no longer valid. Ask the person who invited you to send a new one.';

/**
 * Moves the invitation's expiry into the past in the dashboard's local D1. The lifetime is 7 days and the dashboard has
 * no clock to move, so this is the one way to see a lapsed invitation in real time.
 */
async function expireInvitation(compose: ComposeControl, email: string): Promise<void> {
    // `uniqueEmail` addresses hold no quote, so the literal cannot break out of the statement.
    expect(email).toMatch(/^[\w.@-]+$/);
    const result = await compose.exec('dashboard', [
        'node_modules/.bin/wrangler',
        'd1',
        'execute',
        'DB',
        '--local',
        '--json',
        '--command',
        `UPDATE invites SET expires_at = 0 WHERE email = '${email}' AND accepted_at IS NULL; ` +
            `SELECT count(*) AS expired FROM invites WHERE email = '${email}' AND expires_at = 0`,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const statements = JSON.parse(result.stdout) as { results: { expired?: number }[] }[];
    expect(statements.at(-1)?.results[0]?.expired).toBe(1);
}

test('an expired invitation is refused', async ({ browser, page, dashboard, compose }) => {
    test.setTimeout(120_000);
    await dashboard.signUp(uniqueEmail('invite-admin'));
    const late = uniqueEmail('invite-late');
    await inviteToOrganization(page, late);
    const expiredLink = await dashboard.emailedLink(late, 'team-invite');
    await expireInvitation(compose, late);

    const person = await newPerson(browser);
    await test.step('the lapsed link says so, and offers no way to join', async () => {
        await person.page.goto(expiredLink);
        await expect(person.page.getByText(NO_LONGER_VALID)).toBeVisible();
        await expect(person.page.getByRole('button', { name: /Join|Sign in/ })).toHaveCount(0);
    });
    await person.page.context().close();
});

test('an invitation opened while signed in as another address offers to continue as the invited one', async ({
    page,
    dashboard,
}) => {
    const admin = uniqueEmail('invite-admin');
    await dashboard.signUp(admin);
    const colleague = uniqueEmail('invite-colleague');
    await inviteToOrganization(page, colleague);

    await page.goto(await dashboard.emailedLink(colleague, 'team-invite'));
    await expect(page.getByText(`This invitation is for ${colleague}. You're signed in as ${admin}.`)).toBeVisible();
    await expect(page.getByRole('link', { name: `Stay signed in as ${admin}` })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Join/ })).toHaveCount(0);

    await page.getByRole('button', { name: `Continue as ${colleague}` }).click();
    await expect(page.getByText(`We'll create your Promptbook account for ${colleague}.`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible();
    await expect(page.getByText(`Invitation for ${colleague}`, { exact: false })).toBeVisible();
});
