import type { Page, Response } from '@playwright/test';

import { expect, test } from '../../src/dashboard.ts';
import { addWalletLogin } from '../../src/ui-app.ts';
import { linkTeamEngine, withStepUp } from '../../src/team-steps.ts';

// #312: a sensitive action confirms the passkey in place and then finishes by itself. The step-up runs in a small
// window; when the browser blocks it, the page goes to the step-up page and back, and only an action without a secret
// runs again by itself.

const TEAM = 'Northwind';
const RECORDS = /\/api\/v1\/wallet\/records(\/[^/?]+)?$/;

/** The statuses the engine answered for `method` requests to the Wallet's records, in order. */
function walletAnswers(page: Page, method: string): number[] {
    const statuses: number[] = [];
    page.on('response', (response: Response) => {
        if (response.request().method() === method && RECORDS.test(new URL(response.url()).pathname)) {
            statuses.push(response.status());
        }
    });
    return statuses;
}

/** Fills and submits "Add login", without waiting for the outcome. */
async function submitLogin(page: Page, site: string, password: string): Promise<void> {
    await page.getByRole('button', { name: 'Add login' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add login' });
    await dialog.getByRole('textbox', { name: /^Website/ }).fill(site);
    await dialog.getByRole('textbox', { name: /^Username or email/ }).fill('canary@example.com');
    await dialog.getByLabel(/^Password/).fill(password);
    await dialog.getByRole('button', { name: 'Save login' }).click();
}

/** The full-page fallback: Continue goes to the step-up page, which confirms the passkey and comes back. */
async function confirmOnStepUpPage(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Continue with passkey' }).click();
    await page.waitForURL((url) => url.pathname === '/auth/step-up');
    const back = page.waitForURL((url) => !url.pathname.startsWith('/auth/'));
    const confirm = page.locator('section[data-state="ready"] button[data-action="confirm"]');
    // The page starts the prompt by itself; if that has not finished, it offers the button.
    const ready = confirm.waitFor().then(() => 'ready' as const);
    ready.catch(() => undefined);
    back.catch(() => undefined);
    if ((await Promise.race([back.then(() => 'back' as const), ready])) === 'ready') await confirm.click();
    await back;
}

function newSite(): string {
    return `e2e-${crypto.randomUUID().slice(0, 8)}.example`;
}

test('saving a Wallet login finishes after the passkey in a popup, with the password kept', async ({
    page,
    dashboard,
    mockEngines,
}) => {
    test.setTimeout(420_000);
    const engine = await linkTeamEngine(page, dashboard, () => mockEngines.startUnlinked(), TEAM);
    const { owner } = engine;
    const site = newSite();
    const password = `pw-${crypto.randomUUID()}`;
    await owner.goto(`${engine.origin}/wallet`);
    await expect(owner.getByRole('heading', { level: 1, name: 'Wallet' })).toBeVisible();
    const saves = walletAnswers(owner, 'POST');
    const sentPasswords: string[] = [];
    owner.on('request', (request) => {
        if (request.method() === 'POST' && request.postData()?.includes(password) === true)
            sentPasswords.push(password);
    });

    await engine.expireStepUp();
    const stepUp = await withStepUp(
        owner,
        () => submitLogin(owner, site, password),
        () => expect(owner.getByText(`Login for ${site} saved.`)).toBeVisible({ timeout: 15_000 }),
    );

    expect(stepUp).toBe('asked');
    // Refused for step-up, then sent again from memory after the popup: the member typed the password once.
    expect(saves).toEqual([401, 200]);
    expect(sentPasswords).toHaveLength(2);
    await expect(owner.getByRole('dialog', { name: 'Add login' })).toHaveCount(0);
    await expect(
        owner.getByRole('region', { name: 'Saved logins' }).getByRole('listitem').filter({ hasText: site }),
    ).toBeVisible();
    await expect(owner.getByText('Confirmed. Enter the password again to save.')).toHaveCount(0);
});

test('with popups blocked, step-up goes through its page: a removal runs again by itself, a save asks for the password again', async ({
    page,
    dashboard,
    mockEngines,
}) => {
    test.setTimeout(420_000);
    const engine = await linkTeamEngine(page, dashboard, () => mockEngines.startUnlinked(), TEAM);
    const { owner } = engine;
    // A popup blocker: `window.open` gives no window, which is what the app checks for.
    await owner.addInitScript(() => {
        window.open = () => null;
    });
    await owner.goto(`${engine.origin}/wallet`);
    await expect(owner.getByRole('heading', { level: 1, name: 'Wallet' })).toBeVisible();
    const logins = owner.getByRole('region', { name: 'Saved logins' });

    const kept = newSite();
    await test.step('a login saved while the sign-in still counts as fresh', async () => {
        await addWalletLogin(owner, kept, 'canary@example.com', `pw-${crypto.randomUUID()}`);
    });

    await test.step('removing it after the step-up page finishes without another click', async () => {
        const label = `${kept} · ca…@example.com`;
        const removals = walletAnswers(owner, 'DELETE');
        await engine.expireStepUp();
        await logins
            .getByRole('listitem')
            .filter({ hasText: kept })
            .getByRole('button', { name: `More for ${label}` })
            .click();
        await owner.getByRole('menuitem', { name: 'Remove login' }).click();
        await owner
            .getByRole('dialog', { name: `Remove ${label}?` })
            .getByRole('button', { name: 'Remove login' })
            .click();
        await confirmOnStepUpPage(owner);
        await expect(owner.getByText(`${label} removed.`)).toBeVisible();
        await expect(logins.getByRole('listitem').filter({ hasText: kept })).toHaveCount(0);
        expect(removals).toEqual([401, 204]);
    });

    await test.step('a save after the step-up page puts the form back and asks only for the password', async () => {
        const site = newSite();
        const saves = walletAnswers(owner, 'POST');
        await engine.expireStepUp();
        await submitLogin(owner, site, `pw-${crypto.randomUUID()}`);
        await confirmOnStepUpPage(owner);
        const dialog = owner.getByRole('dialog', { name: 'Add login' });
        await expect(dialog.getByText('Confirmed. Enter the password again to save.')).toBeVisible();
        await expect(dialog.getByRole('textbox', { name: /^Website/ })).toHaveValue(`https://${site}`);
        const passwordField = dialog.getByLabel(/^Password/);
        await expect(passwordField).toHaveValue('');
        await passwordField.fill(`pw-${crypto.randomUUID()}`);
        await dialog.getByRole('button', { name: 'Save login' }).click();
        await expect(owner.getByText(`Login for ${site} saved.`)).toBeVisible();
        expect(saves).toEqual([401, 200]);
    });
});
