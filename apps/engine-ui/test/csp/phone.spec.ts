import type { Locator, Page } from '@playwright/test';

import { FAKE_AGENT_ID, FAKE_LONG_CHAT_ID, FAKE_RUN_ID, FAKE_TASK_ID } from './fake-engine-api.ts';
import { expect, test } from './fixtures.ts';
import { routeSetupScript, SETUP_SCRIPT } from './onboarding-script.ts';

const PHONE = { width: 375, height: 812 } as const;
const SMALL_PHONE = { width: 360, height: 740 } as const;

/** The screens people open on a phone: Home, agents, a chat, tasks, runs and the admin pages. */
const SCREENS = [
    '/',
    '/agents',
    '/agents?view=table',
    `/agents/${FAKE_AGENT_ID}`,
    '/chats',
    `/chats/${FAKE_LONG_CHAT_ID}`,
    '/tasks',
    `/tasks/${FAKE_TASK_ID}`,
    '/runs',
    `/runs/${FAKE_RUN_ID}`,
    '/files',
    '/triggers',
    '/integrations',
    '/members',
    '/security',
    '/wallet',
    '/audit',
    '/settings',
] as const;

test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

/** How far the document scrolls sideways; the page itself must never, only a code block or a tab strip inside it. */
function sidewaysScroll(page: Page): Promise<number> {
    return page.evaluate(() => {
        const scroller = document.scrollingElement ?? document.documentElement;
        return scroller.scrollWidth - scroller.clientWidth;
    });
}

/** A finger held on `target` until `whileHeld` passes, then lifted: a long press, as Chromium's touch emulation sees it. */
async function longPress(page: Page, target: Locator, whileHeld: () => Promise<void>): Promise<void> {
    // The route's crossfade starts once the data is in and covers the page until it ends; a touch on it reaches
    // nothing beneath.
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
    const box = await target.boundingBox();
    if (box === null) throw new Error('the target is not on screen');
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await whileHeld();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('on a phone', () => {
    for (const viewport of [PHONE, SMALL_PHONE]) {
        test(`no screen scrolls sideways at ${String(viewport.width)} px`, async ({ page }) => {
            await page.setViewportSize(viewport);
            for (const path of SCREENS) {
                await page.goto(path);
                await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
                await page.waitForLoadState('networkidle');
                expect.soft(await sidewaysScroll(page), `sideways scroll on ${path}`).toBeLessThanOrEqual(0);
            }
        });
    }

    test('the menu reaches every section, with targets a finger can hit', async ({ page }) => {
        await page.goto('/');
        const open = page.getByRole('button', { name: 'Open navigation' });
        expect((await open.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        await open.tap();
        const drawer = page.getByRole('dialog', { name: 'Menu' });
        const links = drawer.getByRole('navigation', { name: 'Main' }).getByRole('link');
        expect(await links.count()).toBeGreaterThan(5);
        for (const link of await links.all()) {
            expect.soft((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
        }
        await drawer.getByRole('link', { name: 'Runs' }).tap();
        await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
        await expect(drawer).toBeHidden();
    });

    test('a long press on an agent opens its card, and a tap still opens the agent', async ({ page }) => {
        await page.goto(`/chats/${FAKE_LONG_CHAT_ID}`);
        const author = page.getByRole('main').getByRole('link', { name: 'Ada', exact: true }).last();
        const card = page.getByRole('dialog', { name: 'Ada' });
        await longPress(page, author, () => expect(card).toBeVisible());
        await expect(page).toHaveURL(new RegExp(`/chats/${FAKE_LONG_CHAT_ID}$`));
        await expect(card).toBeVisible();
        const box = await card.boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(PHONE.width);

        await page.getByRole('heading', { level: 1 }).tap();
        await expect(card).toBeHidden();
        await author.tap();
        await expect(page).toHaveURL(new RegExp(`/agents/${FAKE_AGENT_ID}`));
    });

    test('a dialog is a sheet on the bottom edge', async ({ page }) => {
        await page.goto('/__gallery');
        await page
            .locator('section[aria-labelledby="gallery-toaster"]')
            .getByRole('button', { name: 'Open a dialog' })
            .tap();
        const dialog = page.getByRole('dialog', { name: 'Revoke this passkey?' });
        await expect(dialog).toBeVisible();
        await dialog.evaluate((element) =>
            Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
        );
        const box = await dialog.boundingBox();
        expect(box?.width).toBe(PHONE.width);
        expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(PHONE.height);
    });

    test('setup fits the screen', async ({ page }) => {
        await page.setViewportSize(SMALL_PHONE);
        await routeSetupScript(page, SETUP_SCRIPT, 1);
        await page.goto('/');
        await expect(page).toHaveURL(/\/onboarding$/);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    });
});
