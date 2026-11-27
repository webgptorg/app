import type { Page } from '@playwright/test';

import { expect, expectNoBrowserErrors, outboxLink, test, uniqueEmail } from './fixtures.ts';

const PHONE = { width: 375, height: 812 } as const;
const SMALL_PHONE = { width: 360, height: 740 } as const;

test.use({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
    // A headless Chrome on macOS otherwise asks the login keychain for its key, a popup on the developer's screen.
    launchOptions: { args: ['--use-mock-keychain', '--password-store=basic'] },
});

/** How far the document scrolls sideways at both phone widths; only a code block or a tab strip inside may. */
async function expectNoSidewaysScroll(page: Page, screen: string): Promise<void> {
    await page.waitForLoadState('networkidle');
    for (const viewport of [PHONE, SMALL_PHONE]) {
        await page.setViewportSize(viewport);
        const overflow = await page.evaluate(
            () =>
                new Promise<number>((resolve) => {
                    requestAnimationFrame(() => {
                        const scroller = document.scrollingElement ?? document.documentElement;
                        resolve(scroller.scrollWidth - scroller.clientWidth);
                    });
                }),
        );
        expect.soft(overflow, `sideways scroll on ${screen} at ${String(viewport.width)} px`).toBeLessThanOrEqual(0);
    }
    await page.setViewportSize(PHONE);
}

test('sign up, subscribe, add a project and invite someone on a phone', async ({
    page,
    authenticators,
    browserReport,
}) => {
    await authenticators.add();
    const email = uniqueEmail('phone');
    await page.goto('/continue');
    await expectNoSidewaysScroll(page, '/continue');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).tap();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await page.goto(await outboxLink(page.request, email, 'signup-link'));
    await expectNoSidewaysScroll(page, 'sign-up');
    await page.getByRole('button', { name: 'Create passkey' }).tap();
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
    await expectNoSidewaysScroll(page, '/');

    // Every section is in the header's own row, reachable and big enough for a finger.
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const link of await nav.getByRole('link').all()) {
        await link.scrollIntoViewIfNeeded();
        await expect(link).toBeInViewport();
        expect.soft((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
    }

    await nav.getByRole('link', { name: 'Billing' }).tap();
    await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Start your 14-day trial of Standard' }).tap();
    await expect(page.getByText('Thank you, your subscription is starting')).toBeVisible();
    await expectNoSidewaysScroll(page, '/billing');

    await page.goto('/engines');
    await page.getByRole('button', { name: 'New project' }).tap();
    // A dialog is a sheet on the bottom edge: the whole width, its actions under the thumb.
    const create = page.getByRole('dialog', { name: 'New project' });
    await create.evaluate((element) =>
        Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    const sheet = await create.boundingBox();
    expect(sheet?.width).toBe(PHONE.width);
    expect(Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0))).toBe(PHONE.height);
    await create.getByLabel('Project name').fill('Acme customer support');
    await create.getByRole('button', { name: 'Create and link a project' }).tap();
    await expect(page).toHaveURL(/\/engines\/new\?.*link=[a-z2-7]{26}/);
    await expectNoSidewaysScroll(page, '/engines/new');

    await page.goto('/engines/all');
    await expectNoSidewaysScroll(page, '/engines/all');

    await page.goto('/people');
    await expectNoSidewaysScroll(page, '/people');
    await page.getByRole('button', { name: 'Invite people' }).tap();
    const invite = page.getByRole('dialog', { name: 'Invite people' });
    await invite.getByRole('textbox').first().fill('a-colleague-with-a-long-address@example.test');
    await invite.getByRole('button', { name: 'Send invitations' }).tap();
    await expect(page.getByRole('listitem').filter({ hasText: 'a-colleague-with-a-long-address' })).toBeVisible();
    await expectNoSidewaysScroll(page, '/people with an invitation');

    await page.goto('/account');
    await expectNoSidewaysScroll(page, '/account');
    await page.goto('/trust');
    await expectNoSidewaysScroll(page, '/trust');

    expectNoBrowserErrors(browserReport());
});
