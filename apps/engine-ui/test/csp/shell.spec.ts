import type { Page } from '@playwright/test';

import { FAKE_AGENT_ID, FAKE_CHAT_ID, FAKE_RUN_ID, FAKE_TASK_ID, FAKE_TRIGGER_ID } from './fake-engine-api.ts';
import { expect, expectCleanPage, test } from './fixtures.ts';

/** Every route the shell registers, an agent page with its Settings, Chat, Runs and Triggers tabs, a chat, a run, a trigger, the gallery, and a path that does not exist. */
const ROUTES = [
    '/',
    '/agents',
    `/agents/${FAKE_AGENT_ID}`,
    `/agents/${FAKE_AGENT_ID}/settings`,
    `/agents/${FAKE_AGENT_ID}/chat`,
    '/chats',
    `/chats/${FAKE_CHAT_ID}`,
    `/agents/${FAKE_AGENT_ID}/runs`,
    '/tasks',
    `/tasks/${FAKE_TASK_ID}`,
    '/runs',
    `/runs/${FAKE_RUN_ID}`,
    `/agents/${FAKE_AGENT_ID}/triggers`,
    '/triggers',
    `/triggers/${FAKE_TRIGGER_ID}`,
    '/triggers/new',
    '/members',
    '/security',
    '/wallet',
    '/audit',
    '/settings',
    '/onboarding',
    '/security/passkeys',
    '/security/sessions',
    '/__gallery',
    '/nowhere',
] as const;
const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'cs'] as const;

/** Stores the preferences before any page script runs, as an earlier visit would have. */
async function prefer(page: Page, theme: string, locale: string): Promise<void> {
    await page.addInitScript(
        ([storedTheme, storedLocale]) => {
            localStorage.setItem('ptbk.theme', storedTheme ?? 'system');
            localStorage.setItem('ptbk.locale', storedLocale ?? 'en');
        },
        [theme, locale],
    );
}

test.describe('every route under the engine CSP', () => {
    for (const theme of THEMES) {
        for (const locale of LOCALES) {
            for (const route of ROUTES) {
                test(`${route} in ${theme}, ${locale}`, async ({ page, visit }) => {
                    await prefer(page, theme, locale);
                    const report = await visit(route);

                    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
                    expect(await page.evaluate(() => document.documentElement.lang)).toBe(locale);
                    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
                        theme === 'dark',
                    );
                    expectCleanPage(report);
                });
            }
        }
    }
});

test.describe('foundations in a real browser', () => {
    test('fonts load from the engine origin', async ({ page, visit, baseURL }) => {
        const fonts: string[] = [];
        page.on('request', (request) => {
            if (request.resourceType() === 'font') fonts.push(request.url());
        });
        expectCleanPage(await visit('/settings'));
        await page.evaluate(() => document.fonts.ready);

        const loaded = await page.evaluate(() =>
            [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family),
        );
        const families = loaded.map((family) => family.replaceAll('"', ''));
        expect(families).toEqual(expect.arrayContaining(['Inter Variable']));
        expect(families).not.toContain('Outfit Variable');
        expect(fonts.length).toBeGreaterThan(0);
        for (const url of fonts) expect(new URL(url).origin).toBe(new URL(baseURL ?? '').origin);
    });

    test('motion tokens follow prefers-reduced-motion', async ({ page, visit }, testInfo) => {
        expectCleanPage(await visit('/settings'));
        const tokens = await page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            return ['--motion-enter', '--motion-exit', '--motion-seal', '--motion-live'].map((name) =>
                style.getPropertyValue(name).trim(),
            );
        });
        // The minifier may write `200ms` as `.2s`; compare durations, not spellings.
        const milliseconds = tokens.map((token) =>
            token.endsWith('ms') ? Number.parseFloat(token) : Number.parseFloat(token) * 1000,
        );
        const reduced = testInfo.project.name.includes('reduced-motion');
        expect(milliseconds).toEqual(reduced ? [100, 100, 0, 0] : [200, 150, 600, 2400]);
    });

    test('route changes use view transitions, except under reduced motion', async ({ page, visit }, testInfo) => {
        await page.addInitScript(() => {
            const scope = window as unknown as { __viewTransitions: number };
            scope.__viewTransitions = 0;
            const original = document.startViewTransition.bind(document);
            document.startViewTransition = (update) => {
                scope.__viewTransitions += 1;
                return original(update);
            };
        });
        expectCleanPage(await visit('/settings'));
        await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Members' }).click();
        await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();

        const transitions = await page.evaluate(
            () => (window as unknown as { __viewTransitions: number }).__viewTransitions,
        );
        if (testInfo.project.name.includes('reduced-motion')) expect(transitions).toBe(0);
        else expect(transitions).toBeGreaterThan(0);
    });

    test('a toast fired inside a modal dialog sits above it, takes focus and clicks, and wraps', async ({
        page,
        visit,
    }) => {
        expectCleanPage(await visit('/__gallery'));
        const demo = page.locator('section[aria-labelledby="gallery-toaster"]');
        await demo.getByRole('button', { name: 'Open a dialog' }).click();
        const dialog = page.getByRole('dialog', { name: 'Revoke this passkey?' });
        await dialog.getByRole('button', { name: 'Fail inside the dialog' }).click();

        const toast = page.getByRole('region', { name: 'Notifications' }).getByRole('listitem');
        await expect(toast).toContainText('This device is the last passkey');
        const reachable = await toast.evaluate((item) => {
            const box = item.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            const dismiss = item.querySelector('button');
            dismiss?.focus();
            return {
                onTop: hit !== null && item.contains(hit),
                focusable: dismiss !== null && document.activeElement === dismiss,
                inert: item.closest('[inert]') !== null || !item.closest('dialog')?.open,
                fits: item.scrollWidth <= item.clientWidth,
            };
        });
        expect(reachable).toEqual({ onTop: true, focusable: true, inert: false, fits: true });

        await toast.getByRole('button', { name: 'Dismiss' }).click();
        await expect(toast).toHaveCount(0);
        await expect(dialog).toBeVisible();
    });

    test('a hovercard stays out of the page until hovered, opens in the top layer and closes with Esc', async ({
        page,
        visit,
    }) => {
        expectCleanPage(await visit('/__gallery'));
        const demo = page.locator('section[aria-labelledby="gallery-hovercard"]');
        const trigger = demo.getByRole('button', { name: '@Copywriter' });
        const card = page.getByRole('dialog', { name: 'Copywriter' });
        // A closed card must neither show nor cover the text around it.
        await expect(card).toBeHidden();
        const box = await trigger.boundingBox();
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[popover]') ?? null, {
            x: (box?.x ?? 0) + 4,
            y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
        });
        expect(hit).toBeNull();

        await trigger.hover();
        await expect(card).toBeVisible();
        await expect(card.getByText('Writes and edits marketing copy.')).toBeVisible();
        await trigger.focus();
        await page.keyboard.press('Tab');
        await expect(card.getByRole('button', { name: 'Open agent' })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(card).toBeHidden();
        await expect(trigger).toBeFocused();
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
    });

    test('a filter bar keeps its closed popover out of the page, and opens fields then values in the top layer', async ({
        page,
        visit,
    }) => {
        expectCleanPage(await visit('/__gallery'));
        const bar = page.locator('section[aria-labelledby="gallery-filter-bar"]').getByRole('search').first();
        const search = bar.getByRole('searchbox', { name: 'Search runs' });
        // A closed popover must neither show nor cover the search and chips beside it.
        const closed = await page.evaluate(
            () =>
                [...document.querySelectorAll('[popover]')].filter(
                    (element) => getComputedStyle(element).display !== 'none',
                ).length,
        );
        expect(closed).toBe(0);
        const box = await search.boundingBox();
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[popover]') ?? null, {
            x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
            y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
        });
        expect(hit).toBeNull();

        await bar.getByRole('button', { name: 'Filter', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Filter' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('listbox', { name: 'Filter by' })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(
            page.getByRole('dialog', { name: 'Status' }).getByRole('listbox', { name: 'Status' }),
        ).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(bar.getByRole('button', { name: 'Filter', exact: true })).toBeFocused();
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
    });

    test('a different primitives palette changes the rendered gallery colours', async ({ page, visit }) => {
        const sample = () =>
            page.evaluate(() => {
                const colour = (selector: string, property: 'backgroundColor' | 'color') => {
                    const element = document.querySelector(selector);
                    return element === null ? 'missing' : getComputedStyle(element)[property];
                };
                return {
                    surface: getComputedStyle(document.documentElement).backgroundColor,
                    text: getComputedStyle(document.documentElement).color,
                    primary: colour('[data-ptbk-gallery] button[class*="--button-primary-bg"]', 'backgroundColor'),
                };
            });
        expectCleanPage(await visit('/__gallery'));
        const original = await sample();

        // Replaces every primitive's colour (and nothing else) with its RGB inverse: the test palette.
        await page.route('**/assets/*.css', async (route) => {
            const response = await route.fetch();
            const css = (await response.text()).replace(
                /(--ptbk-[\w-]+:)([^;}]*)/g,
                (_, name: string, value: string) =>
                    name +
                    value.replace(/#([0-9a-f]{3,8})\b/gi, (hex: string) => {
                        const digits = hex.slice(1);
                        const full = digits.length <= 4 ? digits.replace(/./g, '$&$&') : digits;
                        const rgb = full.slice(0, 6);
                        const inverse = (0xffffff ^ Number.parseInt(rgb, 16)).toString(16).padStart(6, '0');
                        return `#${inverse}${full.slice(6)}`;
                    }),
            );
            await route.fulfill({ response, body: css });
        });
        expectCleanPage(await visit('/__gallery'));
        const swapped = await sample();

        expect(original.primary).not.toBe('missing');
        expect(swapped.surface).not.toBe(original.surface);
        expect(swapped.text).not.toBe(original.text);
        expect(swapped.primary).not.toBe(original.primary);
    });
});

test.describe('overlays in a real browser', () => {
    for (const opener of ['Open md dialog', 'Open end drawer'] as const) {
        test(`${opener}: focus stays inside, Esc closes and returns focus`, async ({ page, visit }) => {
            expectCleanPage(await visit('/__gallery'));
            const trigger = page.getByRole('button', { name: opener });
            await trigger.focus();
            await page.keyboard.press('Enter');
            const dialog = page.locator('dialog[open]');
            await expect(dialog).toBeVisible();
            expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');

            for (let index = 0; index < 10; index += 1) {
                await page.keyboard.press(index % 3 === 2 ? 'Shift+Tab' : 'Tab');
                expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
            }
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(trigger).toBeFocused();
        });
    }

    test('a menu stays in the viewport at 360 px, moves focus with arrows and returns it on Esc', async ({
        page,
        visit,
    }) => {
        expectCleanPage(await visit('/__gallery'));
        await page.setViewportSize({ width: 360, height: 740 });
        const trigger = page.getByRole('button', { name: 'Actions', exact: true });
        await trigger.scrollIntoViewIfNeeded();
        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        const box = await menu.boundingBox();
        expect(box).not.toBeNull();
        expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 360).toBe(true);
        await page.keyboard.press('ArrowDown');
        expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(trigger).toBeFocused();
    });

    test('the sidebar becomes a drawer below 768 px and returns focus on close', async ({ page, visit }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        expectCleanPage(await visit('/settings'));
        const open = page.getByRole('button', { name: 'Open navigation' });
        await open.click();
        const drawer = page.getByRole('dialog', { name: 'Menu' });
        await expect(drawer.getByRole('link', { name: 'Members' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(drawer).toHaveCount(0);
        await expect(open).toBeFocused();
    });
});
