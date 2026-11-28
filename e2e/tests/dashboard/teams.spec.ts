import type { Browser, Page } from '@playwright/test';

import type { DashboardSteps } from '../../src/dashboard.ts';
import { expect, test, uniqueEmail } from '../../src/dashboard.ts';
import { DASHBOARD_ORIGIN } from '../../src/stack.ts';
import type { TeamEngine } from '../../src/team-steps.ts';
import {
    ACKED_WITHIN_MS,
    ONE_HEARTBEAT_MS,
    expectContinuedToEngine,
    expectSignedInToEngine,
    inviteToEngine,
    linkTeamEngine,
    meStatus,
    newPerson,
    waitWithCode,
    withStepUp,
} from '../../src/team-steps.ts';

// X-09: the teams flow through the relay. Each person has their own browser context and authenticator, as they would
// their own laptop; the dashboard only invites and asks to remove, and the engine decides both.

const TEAM = 'Northwind';

interface Joined {
    readonly person: Page;
    readonly email: string;
}

/** Invite, join in one step on to the engine, and wait with a code; the engine's owner approves with that code. */
async function inviteAndApprove(
    browser: Browser,
    page: Page,
    engine: TeamEngine,
    dashboard: DashboardSteps,
): Promise<Joined> {
    const { owner } = engine;
    const email = uniqueEmail('teams-person');
    await test.step('an org admin invites a person to the team', async () => {
        await inviteToEngine(page, TEAM, email);
    });

    const { page: person } = await newPerson(browser);

    await test.step('they join from the invitation in one step and go on to the engine', async () => {
        await person.goto(await dashboard.emailedLink(email, 'team-invite'));
        await expect(person.getByText(`Invitation for ${email}`, { exact: false })).toBeVisible();
        await person.getByRole('button', { name: 'Join', exact: true }).click();
        await expectContinuedToEngine(person, engine.origin);
    });

    let code = '';
    await test.step('they wait on the engine with a code', async () => {
        code = await waitWithCode(person);
        expect(await meStatus(person)).toBe(401);
    });

    await test.step('the engine owner approves with the code', async () => {
        await owner.goto(`${engine.origin}/members`);
        await owner.getByRole('button', { name: 'Approve', exact: true }).click();
        const approve = async (): Promise<void> => {
            const dialog = owner.getByRole('dialog', { name: /^Approve / });
            // Pasted as shown on the waiting page; the sixth digit approves.
            await dialog.getByLabel('Code').fill(code);
        };
        await withStepUp(owner, approve, () =>
            expect(owner.getByText(/can now use this project$/).first()).toBeVisible({ timeout: 15_000 }),
        );
    });

    await test.step('the person uses the engine', async () => {
        await expectSignedInToEngine(person, engine.origin);
    });
    return { person, email };
}

async function removeFromTeam(page: Page, email: string): Promise<void> {
    await page.goto(`${DASHBOARD_ORIGIN}/engines`);
    await page.getByRole('link', { name: TEAM, exact: true }).click();
    await page.getByRole('button', { name: `Actions for ${email}` }).click();
    await page.getByRole('menuitem', { name: 'Remove from project' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove from project' }).click();
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
    mockEngines,
}) => {
    test.setTimeout(420_000);
    // This helper claims the owner through the terminal link; keep the dashboard handoff from racing that flow.
    const engine = await linkTeamEngine(
        page,
        dashboard,
        () => mockEngines.startUnlinked({ ownerHandoff: 'off' }),
        TEAM,
    );
    const { person, email } = await inviteAndApprove(browser, page, engine, dashboard);

    await expect
        .poll(async () => (await reloadedRow(page, email)).getByText('Has access').count(), {
            timeout: ACKED_WITHIN_MS,
            intervals: [2_000],
        })
        .toBe(1);

    await test.step('the org admin removes them, and their session ends within one heartbeat', async () => {
        await removeFromTeam(page, email);
        const removedAt = Date.now();
        await expect
            .poll(() => meStatus(person, engine.origin), { timeout: ONE_HEARTBEAT_MS, intervals: [500] })
            .toBe(401);
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

test('with dashboard removals switched off, the person stays and the team page says to remove them on the project', async ({
    browser,
    page,
    dashboard,
    mockEngines,
}) => {
    test.setTimeout(420_000);
    // This helper claims the owner through the terminal link; keep the dashboard handoff from racing that flow.
    const engine = await linkTeamEngine(
        page,
        dashboard,
        () => mockEngines.startUnlinked({ ownerHandoff: 'off' }),
        TEAM,
    );
    const { person, email } = await inviteAndApprove(browser, page, engine, dashboard);
    const { owner } = engine;

    await test.step('the engine owner switches dashboard removals off', async () => {
        await owner.goto(`${engine.origin}/security`);
        const toggle = owner.getByRole('switch', { name: /Let the organization remove members/ });
        await expect(toggle).toBeChecked();
        await withStepUp(
            owner,
            () => toggle.click(),
            () => expect(owner.getByText('Only this project can remove members now').first()).toBeVisible(),
        );
    });

    await removeFromTeam(page, email);

    await test.step('the team page shows the refusal', async () => {
        await expect
            .poll(async () => (await reloadedRow(page, email)).getByText('remove them on the project').count(), {
                timeout: ACKED_WITHIN_MS,
                intervals: [2_000],
            })
            .toBe(1);
        await expect((await reloadedRow(page, email)).getByText('Still on the project')).toBeVisible();
    });

    expect(await meStatus(person)).toBe(200);
    await person.context().close();
});
