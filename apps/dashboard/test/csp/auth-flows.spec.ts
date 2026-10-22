import type { Page } from '@playwright/test';

import { expect, expectNoBrowserErrors, outboxLink, test, uniqueEmail } from './fixtures.ts';

async function requestLink(page: Page, path: '/signup' | '/recover', email: string, action: string): Promise<void> {
    await page.goto(path);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: action }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

/** Opens an emailed link; the token must leave the address bar and appear in no history state or web storage. */
async function openEmailLink(page: Page, link: string, path: '/signup' | '/recover'): Promise<void> {
    const token = new URL(link).hash.slice(1);
    await page.goto(link);
    await expect(page).toHaveURL((url) => url.pathname === path && url.hash === '');
    const traces = await page.evaluate(() =>
        JSON.stringify([
            window.location.href,
            window.history.state,
            Object.entries(window.localStorage),
            Object.entries(window.sessionStorage),
            document.cookie,
        ]),
    );
    expect(traces).not.toContain(token);
}

async function signUp(page: Page, email: string): Promise<void> {
    await requestLink(page, '/signup', email, 'Send the link');
    await openEmailLink(page, await outboxLink(page.request, email, 'signup-link'), '/signup');
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
    await page.getByRole('button', { name: /^Account menu for / }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

async function signIn(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
}

function passkeyRows(page: Page) {
    return page
        .getByRole('table', { name: 'Passkeys' })
        .getByRole('row')
        .filter({ hasNot: page.getByRole('columnheader') });
}

test('sign up, sign out, sign in, add a passkey, remove the first, recover', async ({
    page,
    authenticators,
    browserReport,
    checkScreen,
}) => {
    const email = uniqueEmail('flow');
    const first = await authenticators.add();

    await page.goto('/signup');
    await checkScreen('/signup');
    await requestLink(page, '/signup', email, 'Send the link');
    await checkScreen('/signup sent');
    await openEmailLink(page, await outboxLink(page.request, email, 'signup-link'), '/signup');
    await checkScreen('/signup passkey step');
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();
    await checkScreen('/');

    await signOut(page);
    await checkScreen('/signin');
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();

    await page.getByRole('link', { name: 'Account' }).click();
    await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
    await expect(passkeyRows(page)).toHaveCount(1);
    await checkScreen('/account');

    // A second device: the first authenticator would refuse, as it already holds a passkey for this account.
    await authenticators.remove(first);
    const second = await authenticators.add();
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Passkey added')).toBeVisible();
    await expect(passkeyRows(page)).toHaveCount(2);

    const signupPasskey = passkeyRows(page).filter({ hasText: 'At sign-up' });
    await signupPasskey.getByRole('button', { name: /^Remove / }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect(passkeyRows(page)).toHaveCount(1);
    await expect(passkeyRows(page).filter({ hasText: 'From your account' })).toHaveCount(1);

    await signOut(page);
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();
    await signOut(page);

    await authenticators.remove(second);
    await authenticators.add();
    await page.goto('/recover');
    await checkScreen('/recover');
    await requestLink(page, '/recover', email, 'Send a recovery link');
    await openEmailLink(page, await outboxLink(page.request, email, 'recovery-link'), '/recover');
    await checkScreen('/recover passkey step');
    await page.getByRole('button', { name: 'Register new passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Access recovered' })).toBeVisible();
    await expect(page.getByText('Your account was recently recovered')).toBeVisible();
    await checkScreen('/recover done');

    await page.getByRole('link', { name: 'Go to your account' }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText('Your account was recently recovered')).toBeVisible();
    await expect(passkeyRows(page).filter({ hasText: 'By recovery' })).toHaveCount(1);
    await checkScreen('/account after recovery');

    expectNoBrowserErrors(browserReport());
});

test('a signed-out visit to /account goes to sign-in and returns afterwards', async ({
    page,
    authenticators,
    browserReport,
}) => {
    await authenticators.add();
    await signUp(page, uniqueEmail('return'));
    await signOut(page);

    await page.goto('/account');
    await expect(page).toHaveURL(/\/signin\?returnTo=%2Faccount$/);
    await signIn(page);
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();

    await page.goto('/signin');
    await expect(page).toHaveURL(/\/engines$/);
    await page.goto('/signup');
    await expect(page).toHaveURL(/\/engines$/);

    expectNoBrowserErrors(browserReport());
});

/** Presses Tab until `name` has focus, as a keyboard user would. */
async function tabTo(page: Page, matches: () => Promise<boolean>): Promise<void> {
    for (let presses = 0; presses < 40; presses++) {
        if (await matches()) return;
        await page.keyboard.press('Tab');
    }
    throw new Error('focus never reached the target');
}

function focused(page: Page, role: 'button' | 'textbox', name: string | RegExp) {
    return () => page.getByRole(role, { name }).evaluate((element) => element === document.activeElement);
}

test('keyboard only: sign up, sign out and sign in', async ({ page, authenticators, browserReport }) => {
    await authenticators.add();
    const email = uniqueEmail('keyboard');

    await page.goto('/signup');
    await tabTo(page, focused(page, 'textbox', 'Email'));
    await page.keyboard.type(email);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    await openEmailLink(page, await outboxLink(page.request, email, 'signup-link'), '/signup');
    await tabTo(page, focused(page, 'button', 'Create passkey'));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();

    await tabTo(page, focused(page, 'button', /^Account menu for /));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await tabTo(page, focused(page, 'button', 'Sign in with a passkey'));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();

    expectNoBrowserErrors(browserReport());
});

test('a malformed link is refused and leaves the address bar too', async ({ page, browserReport }) => {
    await page.goto('/signup#not-a-token');
    await expect(page).toHaveURL((url) => url.pathname === '/signup' && url.hash === '');
    await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
    expectNoBrowserErrors(browserReport());
});

test.describe('the checks themselves', () => {
    test('see an inline style the CSP blocks', async ({ page, browserReport }) => {
        await page.route('**/signin', async (route) => {
            const response = await route.fetch();
            const html = (await response.text()).replace('</head>', '<style>body { color: red; }</style></head>');
            await route.fulfill({ response, body: html });
        });
        await page.goto('/signin');
        await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
        const report = browserReport();
        expect(report.cspViolations).toContainEqual(expect.objectContaining({ directive: 'style-src-elem' }));
        expect(report.cspConsoleErrors.join('\n')).toMatch(/Content Security Policy/);
    });

    test('see a raw HTML sink, which Trusted Types refuses', async ({ page, browserReport }) => {
        await page.goto('/signin');
        await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
        // Trusted Types throws; the violation event is what the check looks for.
        await page
            .evaluate(() => {
                const sink = document.body.appendChild(document.createElement('p'));
                Reflect.set(sink, 'innerHTML', '<b>x</b>');
            })
            .catch(() => undefined);
        await expect
            .poll(() => browserReport().cspViolations)
            .toContainEqual(expect.objectContaining({ directive: 'require-trusted-types-for' }));
    });
});

test('sign up by following the link on the dev mailbox page (X-06)', async ({
    page,
    authenticators,
    browserReport,
    checkScreen,
}) => {
    const email = uniqueEmail('mailbox');
    await authenticators.add();
    await requestLink(page, '/signup', email, 'Send the link');

    await page.goto('/__dev/mailbox');
    await expect(page.getByRole('heading', { name: 'Dev mailbox', level: 1 })).toBeVisible();
    const message = page.getByRole('listitem').filter({ hasText: `To ${email}` });
    await expect(message).toHaveCount(1);
    await checkScreen('/__dev/mailbox');
    await message.getByRole('link', { name: /\/signup#/ }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/signup' && url.hash === '');
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();

    expectNoBrowserErrors(browserReport());
});
