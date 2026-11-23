import type { Page } from '@playwright/test';

import { expect, expectCleanPage, test } from './fixtures.ts';

const demo = (page: Page) => page.locator('[data-voice-demo]');

test.describe('voice under the engine CSP', () => {
    test('reads aloud through Web Audio with no CSP or Trusted Types violation', async ({ page, visit }) => {
        const consoleErrors: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        expectCleanPage(await visit('/__gallery'));

        await demo(page).getByRole('button', { name: 'Read aloud' }).click();
        await expect(demo(page).getByRole('button', { name: 'Stop reading' })).toBeVisible();
        // The tone plays to its end and the button comes back: the audio really ran, not just decoded.
        await expect(demo(page).getByRole('button', { name: 'Read aloud' })).toBeVisible({ timeout: 10_000 });
        await expect(demo(page).getByRole('alert')).toHaveCount(0);

        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
        expect(consoleErrors).toEqual([]);
    });

    test('would refuse a blob: URL in an audio element, which is why playback uses Web Audio', async ({
        page,
        visit,
    }) => {
        await visit('/__gallery');
        await page.evaluate(() => {
            const audio = document.createElement('audio');
            audio.src = URL.createObjectURL(new Blob([new Uint8Array(44)], { type: 'audio/wav' }));
        });
        await expect
            .poll(() => page.evaluate(() => (window.__ptbkCspViolations ?? []).map((violation) => violation.directive)))
            .toContain('media-src');
    });
});
