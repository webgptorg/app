import type { Locator, Page } from '@playwright/test';

import { expect, test, uniqueEmail } from '../../src/dashboard.ts';
import { DASHBOARD_ORIGIN } from '../../src/stack.ts';
import {
    ACKED_WITHIN_MS,
    approvalAnswers,
    emailed,
    expectContinuedToEngine,
    expectSignedInToEngine,
    inviteToEngine,
    linkTeamEngine,
    meStatus,
    newPerson,
    waitWithCode,
    withStepUp,
} from '../../src/team-steps.ts';

// D-31 and X-09: the journeys that bring a colleague onto an engine, end to end through the relay. Everyone has their
// own browser context and authenticator, so each passkey stays with the person who made it.

const TEAM = 'Northwind';
const DASHBOARD_RP_ID = new URL(DASHBOARD_ORIGIN).hostname;
// The approver email goes out with the heartbeat that first counts the request; the one in flight may miss it.
const WAITING_EMAIL_WITHIN_MS = ACKED_WITHIN_MS;
const UNSEEN_EMAIL_AFTER_MS = 16 * 60_000;
const APPROVED = /can now use this project$/;

function approveDialog(page: Page, email: string): Locator {
    return page.getByRole('dialog', { name: `Approve ${email}` });
}

/** The person's request on the owner's Home, under "Needs you"; its Approve link is the request's deep link. */
function needsYouApprove(owner: Page, email: string): Locator {
    return owner
        .getByRole('listitem')
        .filter({ hasText: `${email} is waiting for access` })
        .getByRole('link', { name: 'Approve' });
}

/** Pastes `text` from the clipboard with the keyboard, as someone copying the code from a chat would. */
async function paste(page: Page, into: Locator, text: string): Promise<void> {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: new URL(page.url()).origin,
    });
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    await into.focus();
    await page.keyboard.press('ControlOrMeta+V');
}

/** A six-digit code that is not `code`. */
function wrongCode(code: string): string {
    const digits = code.replace(/\D/g, '');
    return String((Number(digits) + 1) % 1_000_000).padStart(6, '0');
}

test('a new colleague joins from the invite in one step and is let in from the approver email with the code', async ({
    browser,
    page,
    dashboard,
    mockEngines,
}) => {
    test.setTimeout(420_000);
    const engine = await linkTeamEngine(page, dashboard, mockEngines, TEAM);
    const { owner } = engine;
    const jana = uniqueEmail('jana');
    const engineRpId = new URL(engine.origin).hostname;

    await test.step('the owner invites her from "Invite to this engine"', async () => {
        await inviteToEngine(page, TEAM, jana);
    });

    const person = await newPerson(browser);
    const invite = await dashboard.emailedLink(jana, 'team-invite');

    await test.step('she opens the emailed link and joins in one step, with one passkey and no other email', async () => {
        await person.page.goto(invite);
        await expect(person.page.getByText(`Invitation for ${jana}`, { exact: false })).toBeVisible();
        await expect(person.page.getByText(`We'll create your Promptbook account for ${jana}.`)).toBeVisible();
        await person.page.getByRole('button', { name: 'Join', exact: true }).click();
        await expect(person.page.getByRole('heading', { name: "You're in", level: 1 })).toBeVisible();
        expect(await person.passkeys(DASHBOARD_RP_ID)).toBe(1);
        expect((await dashboard.emails(jana)).map((email) => email.template)).toEqual(['team-invite']);
    });

    let code = '';
    await test.step('she goes on to the engine by herself, registers its passkey and waits with a code', async () => {
        await expectContinuedToEngine(person.page, engine.origin);
        code = await waitWithCode(person.page);
        expect(await person.passkeys(engineRpId)).toBe(1);
        expect(await meStatus(person.page)).toBe(401);
    });

    await test.step('the owner gets the approver email, which opens the Members page with her request', async () => {
        // In-app at once; by email once still unseen 15 minutes later (ADR 0027), which the delivery run skips ahead to.
        await expect
            .poll(
                async () => {
                    await dashboard.deliverNotifications(UNSEEN_EMAIL_AFTER_MS);
                    return (await dashboard.emails(engine.ownerEmail)).some(
                        (email) => email.template === 'notifications',
                    );
                },
                { timeout: WAITING_EMAIL_WITHIN_MS, intervals: [2_000] },
            )
            .toBe(true);
        const waiting = await emailed(dashboard, engine.ownerEmail, 'notifications');
        expect(waiting.subject).toBe(`Someone is waiting for access to ${TEAM}`);
        expect(waiting.text).toContain(jana);
        const link = `${engine.origin}/members`;
        expect(waiting.text).toContain(link);
        await owner.goto(link);
        await expect(
            owner.getByRole('listitem').filter({ hasText: jana }).getByText('Suggested role: Member'),
        ).toBeVisible();
        // The engine invites through the dashboard only.
        await expect(owner.getByRole('link', { name: 'Invite in the dashboard' })).toBeVisible();
        await expect(owner.getByRole('button', { name: /^Invite member/ })).toHaveCount(0);
    });

    await test.step('Home lists her under "Needs you", and its Approve deep link opens her request', async () => {
        await owner.goto(`${engine.origin}/`);
        await needsYouApprove(owner, jana).click();
        await expect(owner).toHaveURL(/\/members\?request=[^&]+$/);
        await expect(approveDialog(owner, jana)).toBeVisible();
        await expect(approveDialog(owner, jana).getByLabel('Code')).toBeFocused();
    });

    await test.step('the owner pastes the code, which approves after the passkey step-up', async () => {
        const dialog = approveDialog(owner, jana);
        const approvals = approvalAnswers(owner);
        await engine.expireStepUp();
        const stepUp = await withStepUp(
            owner,
            async () => {
                // The step-up runs in a popup; the dialog stays open and the same approval is sent again after it.
                // As shown on the waiting page, with its space; the sixth digit approves.
                await paste(owner, dialog.getByLabel('Code'), code);
            },
            () => expect(owner.getByText(APPROVED).first()).toBeVisible({ timeout: 15_000 }),
        );
        expect(stepUp).toBe('asked');
        // Refused for step-up, then sent again with the code held in memory: pasted once, no second click.
        expect(approvals).toEqual([401, 201]);
    });

    await test.step('her waiting page signs her in, and she sees the engine', async () => {
        await expectSignedInToEngine(person.page, engine.origin);
    });

    await test.step('the "You\'re in" email reaches her', async () => {
        const granted = await emailed(dashboard, jana, 'access-granted', ACKED_WITHIN_MS);
        expect(granted.subject).toBe(`You're in: open ${TEAM}`);
        expect(granted.text).toContain(`${engine.origin}/`);
    });

    await test.step('the used invitation no longer works', async () => {
        const stranger = await newPerson(browser);
        await stranger.page.goto(invite);
        await expect(
            stranger.page.getByText(
                'This invitation link is no longer valid. Ask the person who invited you to send a new one.',
            ),
        ).toBeVisible();
        await expect(stranger.page.getByRole('button', { name: /Join/ })).toHaveCount(0);
        await stranger.page.context().close();
    });
    await person.page.context().close();
});

test('an existing account signs in and joins; a member cannot approve, and the fifth wrong code removes a request', async ({
    browser,
    page,
    dashboard,
    dashboardFor,
    mockEngines,
}) => {
    test.setTimeout(420_000);
    const engine = await linkTeamEngine(page, dashboard, mockEngines, TEAM);
    const { owner } = engine;
    const petr = uniqueEmail('petr');
    const petrs = await newPerson(browser);

    await test.step('Petr already has an account, and his session on this device has ended', async () => {
        await dashboardFor(petrs.page).signUp(petr);
        // Not "Sign out": it lands on Continue, whose passkey autofill the virtual authenticator answers by itself, so
        // he would be signed in again at once. A person picks the passkey from the autofill first.
        await petrs.page.context().clearCookies();
    });

    await test.step('the owner invites him to the engine', async () => {
        await inviteToEngine(page, TEAM, petr);
    });

    await test.step('he signs in with his passkey on the invite page, which accepts the invitation', async () => {
        await petrs.page.goto(await dashboard.emailedLink(petr, 'team-invite'));
        await expect(
            petrs.page.getByText(`You already have a Promptbook account for ${petr}.`, { exact: false }),
        ).toBeVisible();
        await petrs.page.getByRole('button', { name: 'Sign in and join' }).click();
        await expect(petrs.page.getByRole('heading', { name: "You're in", level: 1 })).toBeVisible();
        expect(await petrs.passkeys(DASHBOARD_RP_ID)).toBe(1);
        await expectContinuedToEngine(petrs.page, engine.origin);
    });

    await test.step('the owner approves him as a member with the code he reads out', async () => {
        const code = await waitWithCode(petrs.page);
        await owner.goto(`${engine.origin}/members`);
        const dialog = approveDialog(owner, petr);
        await owner
            .getByRole('listitem')
            .filter({ hasText: petr })
            .getByRole('button', { name: 'Approve', exact: true })
            .click();
        const approvals = approvalAnswers(owner);
        await engine.expireStepUp();
        const stepUp = await withStepUp(
            owner,
            () => dialog.getByLabel('Code').pressSequentially(code.replace(' ', '')),
            () => expect(owner.getByText(APPROVED).first()).toBeVisible({ timeout: 15_000 }),
        );
        expect(stepUp).toBe('asked');
        expect(approvals).toEqual([401, 201]);
        await expectSignedInToEngine(petrs.page, engine.origin);
    });

    const vera = uniqueEmail('vera');
    const veras = await newPerson(browser);
    let veraCode = '';
    await test.step('Vera, new, joins and waits with a code', async () => {
        await inviteToEngine(page, TEAM, vera);
        await veras.page.goto(await dashboard.emailedLink(vera, 'team-invite'));
        await veras.page.getByRole('button', { name: 'Join', exact: true }).click();
        await expectContinuedToEngine(veras.page, engine.origin);
        veraCode = await waitWithCode(veras.page);
    });

    let deepLink = '';
    await test.step('Home offers the owner her request', async () => {
        await owner.goto(`${engine.origin}/`);
        const approve = needsYouApprove(owner, vera);
        await expect(approve).toBeVisible();
        deepLink = new URL((await approve.getAttribute('href')) ?? '', engine.origin).href;
        expect(new URL(deepLink).searchParams.get('request')).toMatch(/.+/);
    });

    await test.step('Petr, a member, cannot approve her: the deep link offers nothing and the engine refuses', async () => {
        await petrs.page.goto(deepLink);
        await expect(petrs.page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(approveDialog(petrs.page, vera)).toHaveCount(0);
        await expect(petrs.page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
        const requestId = new URL(deepLink).searchParams.get('request') ?? '';
        const refused = await petrs.page.evaluate(
            async ({ id, typed }) => {
                const response = await fetch(`/api/v1/access-requests/${encodeURIComponent(id)}/approve`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ code: typed, role: 'member' }),
                });
                return response.status;
            },
            { id: requestId, typed: veraCode.replace(' ', '') },
        );
        expect(refused).toBe(403);
    });

    await test.step('each wrong code says how many tries remain, and the fifth removes the request', async () => {
        await owner.goto(deepLink);
        const dialog = approveDialog(owner, vera);
        await expect(dialog).toBeVisible();
        const code = dialog.getByLabel('Code');
        const wrong = wrongCode(veraCode);
        await withStepUp(
            owner,
            async () => {
                await expect(dialog).toBeVisible();
                await code.pressSequentially(wrong);
            },
            () => expect(dialog.getByText(`Check it with ${vera}: 4 tries left`, { exact: false })).toBeVisible(),
        );
        for (const left of ['3 tries left', '2 tries left', '1 try left']) {
            await expect(code).toHaveValue('');
            await code.pressSequentially(wrong);
            await expect(dialog.getByText(`Check it with ${vera}: ${left}`, { exact: false })).toBeVisible();
        }
        await expect(code).toHaveValue('');
        await code.pressSequentially(wrong);
        await expect(
            dialog.getByText(`Too many wrong codes, so ${vera}'s request was removed.`, { exact: false }),
        ).toBeVisible();
        await expect(owner.getByText(APPROVED)).toHaveCount(0);
    });

    await test.step('her waiting page stops waiting, and she is not signed in', async () => {
        await expect(veras.page.locator('section[data-state="declined"]')).toBeVisible();
        expect(await meStatus(veras.page)).toBe(401);
    });
    await petrs.page.context().close();
    await veras.page.context().close();
});
