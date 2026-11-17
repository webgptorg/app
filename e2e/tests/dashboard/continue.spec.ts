import type { Page } from '@playwright/test';

import { expect, test, uniqueEmail } from '../../src/dashboard.ts';
import { DASHBOARD_ORIGIN } from '../../src/stack.ts';
import { emailed, newPerson } from '../../src/team-steps.ts';

// D-32: one Continue screen signs in and signs up. A passkey on this device signs in without mail; otherwise the
// server answers every address alike and the email says what comes next, so the screen never tells whether an
// address has an account.

const SIGNUP_START = `${DASHBOARD_ORIGIN}/api/auth/signup/start`;
// Per response, not per address or account: these may differ between two identical answers.
const VARYING_HEADERS = new Set(['date', 'cf-ray', 'report-to', 'nel']);

interface Answer {
    readonly status: number;
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
    /** What the screen says next, with the address itself taken out. */
    readonly screen: string;
}

/** Continue with `email` on a device that holds no passkey for it: what the server answers and the screen shows. */
async function continueWithoutPasskey(page: Page, email: string): Promise<Answer> {
    await page.goto(`${DASHBOARD_ORIGIN}/continue`);
    await expect(page.getByRole('heading', { name: 'Sign in or create an account' })).toBeVisible();
    await page.getByLabel('Email').fill(email);
    const answered = page.waitForResponse((response) => response.url() === SIGNUP_START);
    await page.getByRole('button', { name: 'Continue' }).click();
    const response = await answered;
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const headers = Object.fromEntries(
        Object.entries(await response.allHeaders()).filter(([name]) => !VARYING_HEADERS.has(name)),
    );
    const screen = ((await page.getByText(/^We sent an email to /).textContent()) ?? '').replaceAll(email, '<email>');
    return { status: response.status(), body: await response.text(), headers, screen };
}

test('an existing account with a passkey on this device signs in from Continue, and no email goes out', async ({
    page,
    dashboard,
}) => {
    const email = uniqueEmail('continue-passkey');
    await dashboard.signUp(email);
    await dashboard.signOut();
    const before = (await dashboard.emails(email)).length;
    const mailed: string[] = [];
    page.on('request', (request) => {
        if (request.url() === SIGNUP_START) mailed.push(request.url());
    });

    await dashboard.signIn(email);

    expect(mailed).toEqual([]);
    expect(await dashboard.emails(email)).toHaveLength(before);
});

test('an existing account on a new device and a new address get the same answer, and each finishes from its email', async ({
    browser,
    dashboard,
}) => {
    test.setTimeout(120_000);
    const existing = uniqueEmail('continue-existing');
    await dashboard.signUp(existing);
    const newDevice = await newPerson(browser);
    const fresh = uniqueEmail('continue-new');
    const newcomer = await newPerson(browser);

    const existingAnswer = await continueWithoutPasskey(newDevice.page, existing);
    const freshAnswer = await continueWithoutPasskey(newcomer.page, fresh);

    await test.step('the answers are identical', () => {
        expect(existingAnswer.status).toBe(202);
        expect(freshAnswer).toEqual(existingAnswer);
    });

    await test.step('the existing account is told it has one, and recovers on the new device by email', async () => {
        const notice = await emailed(dashboard, existing, 'account-exists');
        const recover = notice.text.match(/https:\/\/\S+\/recover\b\S*/)?.[0];
        expect(recover).toBe(`${DASHBOARD_ORIGIN}/recover`);
        expect(notice.text).toContain(`${DASHBOARD_ORIGIN}/continue`);
        const { page } = newDevice;
        await page.goto(recover ?? '');
        await page.getByLabel('Email').fill(existing);
        await page.getByRole('button', { name: 'Send a recovery link' }).click();
        await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
        await page.goto(await dashboard.emailedLink(existing, 'recovery-link'));
        await page.getByRole('button', { name: 'Register new passkey' }).click();
        await expect(page.getByRole('heading', { name: 'Access recovered' })).toBeVisible();
        await page.goto(`${DASHBOARD_ORIGIN}/`);
        await expect(page.getByRole('heading', { name: 'Engines', level: 1 })).toBeVisible();
        expect(await newDevice.passkeys(new URL(DASHBOARD_ORIGIN).hostname)).toBe(1);
    });

    await test.step('the new address finishes creating its account from the emailed link', async () => {
        const { page } = newcomer;
        expect((await dashboard.emails(fresh)).map((email) => email.template)).toEqual(['signup-link']);
        await page.goto(await dashboard.emailedLink(fresh, 'signup-link'));
        await page.getByRole('button', { name: 'Create passkey' }).click();
        await expect(page.getByRole('heading', { name: 'Engines', level: 1 })).toBeVisible();
    });

    await newDevice.page.context().close();
    await newcomer.page.context().close();
});
