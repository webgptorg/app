import type { Browser, Page } from '@playwright/test';
import { devices } from '@playwright/test';

import type { OneOffContainer } from '../../src/compose.ts';
import type { DashboardSteps } from '../../src/dashboard.ts';
import { ENGINE_CLI, addPasskeyAuthenticator, expect, test, uniqueEmail } from '../../src/dashboard.ts';
import { devInstallLinkCode, parseSetupLink, terminalIdentity } from '../../src/dashboard-outputs.ts';
import { DASHBOARD_ORIGIN, DASHBOARD_TIMING } from '../../src/stack.ts';

// X-09: the teams flow through the relay. Each person has their own browser context and authenticator, as they would
// their own laptop; the dashboard only invites and asks to remove, and the engine decides both.

const TEAM = 'Northwind';
const HEARTBEAT_MS = DASHBOARD_TIMING.heartbeatIntervalS * 1000;
// The engine picks a revocation up in the reply to its next heartbeat; a beat in flight may have missed it.
const ONE_HEARTBEAT_MS = HEARTBEAT_MS * 2;
// The ack rides on the beat after that one, and the team page refetches on load.
const ACKED_WITHIN_MS = HEARTBEAT_MS * 3 + 10_000;
const REACHABLE_WITHIN_MS = 90_000;
const SETUP_LINK_WITHIN_MS = 120_000;

interface Engine {
    readonly container: OneOffContainer;
    readonly origin: string;
    /** The admin's tab on the engine, signed in as its owner. */
    readonly owner: Page;
}

interface Joined {
    readonly person: Page;
    readonly email: string;
}

function meStatus(page: Page): Promise<number> {
    return page.evaluate(async () => (await fetch('/api/v1/me', { credentials: 'same-origin' })).status);
}

/**
 * Runs `act`, then answers the engine's step-up if it asks: the passkey page, back to the app, and `act` again where
 * the app needs the input anew. Ends when `done` shows.
 */
async function withStepUp(page: Page, act: () => Promise<void>, done: () => Promise<void>): Promise<void> {
    await act();
    const stepUp = page.getByRole('button', { name: 'Continue with passkey' });
    // The loser of the race fails later on its own timeout; only the winner counts.
    const finished = done().then(() => 'done' as const);
    const asked = stepUp.waitFor().then(() => 'asked' as const);
    finished.catch(() => undefined);
    asked.catch(() => undefined);
    if ((await Promise.race([finished, asked])) === 'done') return;
    await stepUp.click();
    await page.locator('section[data-state="ready"] button[data-action="confirm"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/'));
    await act();
    await done();
}

/** The org admin's account, a team, its engine linked and reachable, with the admin as the engine's owner. */
async function linkTeamEngine(
    page: Page,
    dashboard: DashboardSteps,
    startUnlinked: () => Promise<OneOffContainer>,
): Promise<Engine> {
    await dashboard.signUp(uniqueEmail('teams-admin'));
    await dashboard.subscribe();

    await page.goto(`${DASHBOARD_ORIGIN}/engines`);
    await page.getByRole('button', { name: 'New engine' }).click();
    await page.getByLabel('Engine name').fill(TEAM);
    await page.getByRole('button', { name: 'Create and link an engine' }).click();
    await expect(page).toHaveURL(/\/engines\/new\?.*link=[a-z2-7]{26}/);
    const linkCode = devInstallLinkCode((await page.getByRole('tabpanel').locator('code').textContent()) ?? '');

    const container = await startUnlinked();
    await expect
        .poll(async () => (await container.exec([...ENGINE_CLI, 'status', '--json'])).exitCode, {
            timeout: 60_000,
            intervals: [500, 1_000],
        })
        .toBe(0);
    const connect = await container.exec([...ENGINE_CLI, 'connect', '--link', linkCode]);
    expect(connect.exitCode, connect.stderr).toBe(0);
    const { hostname } = terminalIdentity(connect.stdout);

    await expect(page.locator('section[data-link-state]')).toHaveAttribute('data-link-state', 'owner-pending', {
        timeout: REACHABLE_WITHIN_MS,
    });
    let setup = '';
    await expect
        .poll(
            async () => {
                const result = await container.exec([...ENGINE_CLI, 'setup-link', '--json', '--no-wait']);
                setup = result.stdout;
                return result.exitCode;
            },
            { timeout: SETUP_LINK_WITHIN_MS, intervals: [1_000] },
        )
        .toBe(0);

    const ownerPage = await page.context().newPage();
    await addPasskeyAuthenticator(ownerPage);
    await ownerPage.goto(parseSetupLink(setup).url);
    await ownerPage.locator('button[data-action="create"]').click();
    await expect(ownerPage.getByRole('heading', { name: 'You are the owner' })).toBeVisible();
    return { container, origin: `https://${hostname}`, owner: ownerPage };
}

/** Invite, accept, open the team and wait with a code; the engine's owner approves with that code. */
async function inviteAndApprove(
    browser: Browser,
    page: Page,
    engine: Engine,
    dashboard: DashboardSteps,
    dashboardFor: (page: Page) => DashboardSteps,
): Promise<Joined> {
    const { owner } = engine;
    const email = uniqueEmail('teams-person');
    await test.step('an org admin invites a person to the team', async () => {
        await page.goto(`${DASHBOARD_ORIGIN}/engines`);
        await page.getByRole('link', { name: TEAM, exact: true }).click();
        await expect(page.getByRole('heading', { name: TEAM, level: 1 })).toBeVisible();
        await page.getByRole('button', { name: 'Invite people' }).click();
        const dialog = page.getByRole('dialog', { name: 'Invite people' });
        await dialog.getByLabel('Email addresses').fill(email);
        await expect(dialog.getByRole('checkbox', { name: TEAM })).toBeChecked();
        await dialog.getByRole('button', { name: 'Send invitations' }).click();
        await expect(page.getByRole('listitem').filter({ hasText: email }).getByText('Invited')).toBeVisible();
    });

    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const person = await context.newPage();
    await addPasskeyAuthenticator(person);
    const steps = dashboardFor(person);

    await test.step('they sign up and accept', async () => {
        await steps.signUp(email);
        await person.goto(await dashboard.emailedLink(email, 'team-invite'));
        await person.getByRole('button', { name: 'Accept invitation' }).click();
        await expect(person).toHaveURL(/\/engines$/);
    });

    let code = '';
    await test.step('they open the team and wait with a code', async () => {
        await person.getByRole('button', { name: new RegExp(`^Open ${TEAM}`) }).click();
        await person.waitForURL((url) => url.origin === engine.origin && url.pathname === '/auth/join');
        expect(new URL(person.url()).hash).toBe('');
        await person.locator('section[data-state="valid"] button[data-action="create"]').click();
        await expect(person.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
        code = (await person.locator('section[data-state="waiting"] [data-join-code]').first().textContent()) ?? '';
        expect(code).toMatch(/^\d{3} \d{3}$/);
        expect(await meStatus(person)).toBe(401);
    });

    await test.step('the engine owner approves with the code', async () => {
        await owner.goto(`${engine.origin}/members`);
        const approve = async (): Promise<void> => {
            const dialog = owner.getByRole('dialog', { name: /^Approve / });
            if (!(await dialog.isVisible())) await owner.getByRole('button', { name: 'Approve', exact: true }).click();
            // Pasted as shown on the waiting page; the sixth digit approves.
            await dialog.getByLabel('Code').fill(code);
        };
        await withStepUp(owner, approve, () =>
            expect(owner.getByText(/can now use this engine$/).first()).toBeVisible({ timeout: 15_000 }),
        );
    });

    await test.step('the person uses the engine', async () => {
        await person.waitForURL((url) => url.origin === engine.origin && !url.pathname.startsWith('/auth/'));
        await expect(person.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await meStatus(person)).toBe(200);
    });
    return { person, email };
}

async function removeFromTeam(page: Page, email: string): Promise<void> {
    await page.goto(`${DASHBOARD_ORIGIN}/engines`);
    await page.getByRole('link', { name: TEAM, exact: true }).click();
    await page.getByRole('button', { name: `Actions for ${email}` }).click();
    await page.getByRole('menuitem', { name: 'Remove from engine' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove from engine' }).click();
}

async function reloadedRow(page: Page, email: string) {
    await page.reload();
    await expect(page.getByRole('heading', { name: TEAM, level: 1 })).toBeVisible();
    return page.getByRole('listitem').filter({ hasText: email });
}

test('invite, approve, use the engine, and a dashboard removal ends the session within a heartbeat', async ({
    browser,
    page,
    dashboard,
    dashboardFor,
    mockEngines,
}) => {
    test.setTimeout(420_000);
    const engine = await linkTeamEngine(page, dashboard, () => mockEngines.startUnlinked());
    const { person, email } = await inviteAndApprove(browser, page, engine, dashboard, dashboardFor);

    await expect
        .poll(async () => (await reloadedRow(page, email)).getByText('Has access').count(), {
            timeout: ACKED_WITHIN_MS,
            intervals: [2_000],
        })
        .toBe(1);

    await test.step('the org admin removes them, and their session ends within one heartbeat', async () => {
        await removeFromTeam(page, email);
        const removedAt = Date.now();
        await expect.poll(() => meStatus(person), { timeout: ONE_HEARTBEAT_MS, intervals: [500] }).toBe(401);
        test.info().annotations.push({
            type: 'session ended after',
            description: `${String(Date.now() - removedAt)} ms`,
        });
    });

    await test.step('the engine acks, and they leave the team page', async () => {
        await expect
            .poll(async () => (await reloadedRow(page, email)).count(), {
                timeout: ACKED_WITHIN_MS,
                intervals: [2_000],
            })
            .toBe(0);
    });
    await person.context().close();
});

test('with dashboard removals switched off, the person stays and the team page says to remove them on the engine', async ({
    browser,
    page,
    dashboard,
    dashboardFor,
    mockEngines,
}) => {
    test.setTimeout(420_000);
    const engine = await linkTeamEngine(page, dashboard, () => mockEngines.startUnlinked());
    const { person, email } = await inviteAndApprove(browser, page, engine, dashboard, dashboardFor);
    const { owner } = engine;

    await test.step('the engine owner switches dashboard removals off', async () => {
        await owner.goto(`${engine.origin}/security`);
        const toggle = owner.getByRole('switch', { name: /Let the organization remove members/ });
        await expect(toggle).toBeChecked();
        await withStepUp(
            owner,
            () => toggle.click(),
            () => expect(owner.getByText('Only this engine can remove members now').first()).toBeVisible(),
        );
    });

    await removeFromTeam(page, email);

    await test.step('the team page shows the refusal', async () => {
        await expect
            .poll(async () => (await reloadedRow(page, email)).getByText('remove them on the engine').count(), {
                timeout: ACKED_WITHIN_MS,
                intervals: [2_000],
            })
            .toBe(1);
        await expect((await reloadedRow(page, email)).getByText('Still on the engine')).toBeVisible();
    });

    expect(await meStatus(person)).toBe(200);
    await person.context().close();
});
