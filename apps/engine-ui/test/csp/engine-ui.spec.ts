import { ENGINE_API_PREFIX } from '@ptbk/engine-api';

import { FAKE_AGENT_ID, FAKE_CHAT_ID, HOSTILE_TARGET_NAME, RAW_HEARTBEAT } from './fake-engine-api.ts';
import { expect, expectCleanPage, readBuiltIndexHtml, test } from './fixtures.ts';

test.describe('the built bundle under the engine CSP', () => {
    test('/ redirects to the agents route and runs without a violation', async ({ page, visit }) => {
        const report = await visit('/');

        await expect(page).toHaveURL(/\/agents$/);
        await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
        expectCleanPage(report);
    });

    test('/agents loads its data and meets the UX checks', async ({ page, visit }) => {
        const report = await visit('/agents');

        await expect(page.getByRole('link', { name: 'Ada' })).toBeVisible();
        await expect(page.getByRole('row').filter({ hasText: 'Grace' }).getByText('Jana Nováková')).toBeVisible();
        expectCleanPage(report);
    });

    test(`/agents/${FAKE_AGENT_ID} and its Settings tab meet the UX checks`, async ({ page, visit }) => {
        const overview = await visit(`/agents/${FAKE_AGENT_ID}`);
        await expect(page.getByRole('heading', { level: 1, name: 'Ada' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
        expectCleanPage(overview);

        const settings = await visit(`/agents/${FAKE_AGENT_ID}/settings`);
        await expect(page.getByRole('combobox', { name: 'Visibility' })).toHaveValue('public');
        expectCleanPage(settings);
    });

    test(`/agents/${FAKE_AGENT_ID}/chat lists every chat and meets the UX checks`, async ({ page, visit }) => {
        const report = await visit(`/agents/${FAKE_AGENT_ID}/chat`);
        await expect(page.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('link', { name: 'Injection demo' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Do you ship to Brno?' })).toBeVisible();
        expectCleanPage(report);
    });

    test('hostile agent output stays inert, before and after sending a message', async ({ page, visit }) => {
        const report = await visit(`/agents/${FAKE_AGENT_ID}/chat/${FAKE_CHAT_ID}`);
        const history = page.getByRole('region', { name: 'Messages' });
        await expect(history.getByText('Image: x').first()).toBeVisible();
        // The code block's grammar is a lazy chunk; it loads from the engine's own origin.
        await expect(history.locator('.tok-keyword').first()).toBeVisible();
        expectCleanPage(report);

        const foreign: string[] = [];
        const origin = new URL(page.url()).origin;
        page.on('request', (request) => {
            if (new URL(request.url()).origin !== origin) foreign.push(request.url());
        });
        const composer = page.getByRole('textbox', { name: 'Message' });
        await composer.fill('Show it again');
        await composer.press('Enter');
        await expect(page.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveText('Ada replied');
        await expect(history.getByText('Image: x')).toHaveCount(2);
        await page.waitForLoadState('networkidle');

        expect(await history.locator('img, script, iframe, object, embed, [src], [srcset]').count()).toBe(0);
        const hrefs = await history
            .locator('a[href]')
            .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
        expect(hrefs.length).toBeGreaterThan(0);
        expect(hrefs.every((href) => href?.startsWith('https://') === true)).toBe(true);
        await expect(history.getByText('<script>alert(1)</script>', { exact: false }).first()).toBeVisible();
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
        expect(foreign).toEqual([]);
    });

    test("/security shows the engine's own values verbatim and meets the UX checks", async ({ page, visit }) => {
        const report = await visit('/security');

        await expect(page.getByRole('heading', { name: /your data stays on your server/ })).toBeVisible();
        await expect(page.getByText('A certificate this engine did not request exists for its hostname')).toBeVisible();
        await expect(page.getByTestId('heartbeat-body')).toHaveText(RAW_HEARTBEAT, { useInnerText: false });
        await expect(page.getByText('The UI version does not match')).toHaveCount(0);
        expectCleanPage(report);
    });

    test('/audit shows hostile target names as text, expands by keyboard and meets the UX checks', async ({
        page,
        visit,
    }) => {
        const report = await visit('/audit');
        await expect(page.getByText('Hash chain intact')).toBeVisible();
        const table = page.getByRole('table');
        await expect(table.getByText(HOSTILE_TARGET_NAME, { exact: true })).toBeVisible();
        expect(await table.locator('img, script, iframe, object, embed').count()).toBe(0);
        expectCleanPage(report);

        const expand = page.getByRole('button', { name: /^Expand / }).first();
        const label = (await expand.getAttribute('aria-label')) ?? '';
        await expand.focus();
        await page.keyboard.press('Enter');
        const collapse = page.getByRole('button', { name: label.replace(/^Expand/, 'Collapse'), exact: true });
        await expect(collapse).toHaveAttribute('aria-expanded', 'true');
        await expect(collapse).toBeFocused();
        await expect(page.getByText('Entry hash', { exact: true })).toBeVisible();
        await page.setViewportSize({ width: 360, height: 740 });
        await expect(page.getByText('Entry hash', { exact: true })).toBeVisible();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        ).toBeLessThanOrEqual(0);
        await page.setViewportSize({ width: 1280, height: 720 });

        const requested: string[] = [];
        page.on('request', (request) => requested.push(request.url()));
        await page.getByRole('button', { name: 'Next page' }).hover();
        await expect.poll(() => requested.some((url) => url.includes('/audit?') && url.includes('cursor='))).toBe(true);
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
    });

    test('/audit restores its filters from the URL and meets the UX checks', async ({ page, visit }) => {
        const report = await visit('/audit?outcome=denied&from=2026-09-01&to=2026-09-03');
        await expect(page.getByRole('combobox', { name: 'Outcome' })).toHaveValue('denied');
        await expect(page.getByRole('table')).toBeVisible();
        expectCleanPage(report);
    });

    test('the new secret dialog loads its form under the CSP and keeps the value out of the page', async ({
        page,
        visit,
    }) => {
        const report = await visit('/secrets');
        await expect(page.getByText('GITHUB_TOKEN')).toBeVisible();

        await page.getByRole('button', { name: 'New secret' }).click();
        const dialog = page.getByRole('dialog', { name: 'New secret' });
        await dialog.getByRole('textbox', { name: /^Name/ }).fill('OPENAI_KEY');
        await dialog.getByLabel(/^Value/).fill('sk-csp-canary');
        await expect(dialog.getByLabel(/^Value/)).toHaveAttribute('type', 'password');
        await dialog.getByRole('button', { name: 'Save secret' }).click();
        await expect(page.getByText('Secret OPENAI_KEY saved')).toBeVisible();
        expect(await page.content()).not.toContain('sk-csp-canary');
        expectCleanPage(report);
    });

    test('row actions and the delete dialog work by keyboard and return focus', async ({ page, visit }) => {
        expectCleanPage(await visit('/agents'));
        const trigger = page.getByRole('button', { name: 'Actions for Ada' });
        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        const menu = page.getByRole('menu', { name: 'Actions for Ada' });
        await expect(menu).toBeVisible();
        await page.keyboard.press('End');
        await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
        await page.keyboard.press('Enter');

        const dialog = page.getByRole('dialog', { name: 'Delete Ada?' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('textbox', { name: 'Type Ada to confirm' })).toBeFocused();
        await expect(dialog.getByRole('button', { name: 'Delete' })).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
    });

    for (const intent of ['hover', 'focus'] as const) {
        test(`a link to /agents preloads its chunk and data on ${intent}`, async ({ page, visit }) => {
            expectCleanPage(await visit('/nowhere'));
            const requested: string[] = [];
            page.on('request', (request) => requested.push(new URL(request.url()).pathname));
            const loaded = new Set(requested);

            const link = page.getByRole('link', { name: 'Agents', exact: true });
            if (intent === 'hover') await link.hover();
            else await link.focus();

            await expect
                .poll(() => requested.filter((path) => path.startsWith(`${ENGINE_API_PREFIX}/agents`)))
                .toHaveLength(1);
            await expect
                .poll(() => requested.filter((path) => path.endsWith('.js') && !loaded.has(path)).length)
                .toBeGreaterThan(0);
            expect(new URL(page.url()).pathname).toBe('/nowhere');
        });
    }
});

test.describe('the checks themselves', () => {
    test('fail on an inline <style>', async ({ visit, serveFixturePage }) => {
        const builtIndexHtml = await readBuiltIndexHtml();
        await serveFixturePage(
            '/agents?fixture=inline-style',
            builtIndexHtml.replace('</head>', '<style>body { color: red; }</style></head>'),
        );

        const report = await visit('/agents?fixture=inline-style');

        expect(report.consoleErrors.join('\n')).toMatch(/Content Security Policy/);
        expect(report.consoleErrors.join('\n')).toMatch(/style-src/);
    });

    test('fail on a raw HTML sink, which Trusted Types refuses', async ({ page, visit, serveFixturePage }) => {
        const builtIndexHtml = await readBuiltIndexHtml();
        await page.route('**/__fixtures/raw-html.js', (route) =>
            route.fulfill({
                contentType: 'text/javascript',
                body: "document.body.insertAdjacentElement('beforeend', document.createElement('p')).innerHTML = '<b>x</b>';",
            }),
        );
        await serveFixturePage(
            '/agents?fixture=raw-html',
            builtIndexHtml.replace('</body>', '<script type="module" src="/__fixtures/raw-html.js"></script></body>'),
        );

        const report = await visit('/agents?fixture=raw-html');

        expect(report.cspViolations).toContainEqual(
            expect.objectContaining({ directive: 'require-trusted-types-for' }),
        );
        expect(report.pageErrors.join('\n')).toMatch(/TrustedHTML/);
    });

    test('fail on a fixed 400 px element at 360 px', async ({ page, visit, serveFixturePage }) => {
        const builtIndexHtml = await readBuiltIndexHtml();
        await page.route('**/__fixtures/wide.css', (route) =>
            route.fulfill({ contentType: 'text/css', body: '.ptbk-fixture-wide { width: 400px; height: 1px; }' }),
        );
        await serveFixturePage(
            '/agents?fixture=wide',
            builtIndexHtml
                .replace('</head>', '<link rel="stylesheet" href="/__fixtures/wide.css"></head>')
                .replace('<body>', '<body><div class="ptbk-fixture-wide"></div>'),
        );

        const report = await visit('/agents?fixture=wide');

        expect(report.overflowPx).toBeGreaterThan(0);
        expect(report.consoleErrors).toEqual([]);
    });
});
