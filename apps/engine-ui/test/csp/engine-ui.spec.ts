import AxeBuilder from '@axe-core/playwright';
import { ENGINE_API_PREFIX } from '@ptbk/engine-api';

import {
    FAKE_AGENT_ID,
    FAKE_CHAT_ID,
    FAKE_FILE_ID,
    FAKE_INTEGRATION_ID,
    FAKE_RUN_ID,
    FAKE_TRIGGER_ID,
    HOSTILE_AGENT_NAME,
    HOSTILE_FILE_NAME,
    HOSTILE_RUN_TEXT,
    HOSTILE_TARGET_NAME,
    HOSTILE_TOOL_TEXT,
    RAW_HEARTBEAT,
    routeFakeEngineApi,
} from './fake-engine-api.ts';
import { expect, expectCleanPage, readBuiltIndexHtml, test } from './fixtures.ts';

test.describe('the built bundle under the engine CSP', () => {
    test("/ is the owner's control center, keeps engine text inert and meets the UX checks", async ({
        page,
        visit,
    }) => {
        const report = await visit('/');

        await expect(page.getByRole('heading', { level: 1, name: /, Owner$/ })).toBeVisible();
        await expect(page.getByText('Running now', { exact: true })).toBeVisible();
        const feed = page.getByRole('region', { name: 'Activity' });
        await expect(feed.getByText('deploy.started')).toBeVisible();
        await expect(feed.getByText('Jana Nováková joined')).toBeVisible();
        await expect(feed.getByRole('link', { name: HOSTILE_AGENT_NAME })).toHaveAttribute(
            'href',
            `/agents/${FAKE_AGENT_ID}`,
        );
        expect(await feed.locator('img, script, iframe').count()).toBe(0);
        expect(await feed.textContent()).not.toContain('javascript:alert(1)');
        expectCleanPage(report);
    });

    test("/ is a member's own home without the control center and meets the UX checks", async ({ page, visit }) => {
        await routeFakeEngineApi(page, {
            member: {
                id: 'member-jana',
                displayName: 'Jana Nováková',
                role: 'member',
                permissions: ['agents.read', 'chats.read', 'chats.write', 'runs.read'],
            },
        });
        const report = await visit('/');

        await expect(page.getByRole('heading', { level: 1, name: /, Jana Nováková$/ })).toBeVisible();
        await expect(
            page.getByRole('region', { name: 'Agents you can use' }).getByRole('link', { name: 'Grace' }),
        ).toBeVisible();
        await expect(page.getByRole('region', { name: 'Recent chats' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Activity' })).toHaveCount(0);
        expectCleanPage(report);
    });

    test('the command palette opens with Ctrl+K, finds an agent, passes axe and navigates', async ({ page, visit }) => {
        expectCleanPage(await visit('/settings'));

        await page.keyboard.press('Control+k');
        const search = page.getByRole('combobox', { name: 'Search agents, runs, pages and commands' });
        await expect(search).toBeFocused();
        await search.fill('Grace');
        await expect(page.getByRole('group', { name: 'Agents' }).getByRole('option')).toHaveText([/^Grace/]);
        const axe = await new AxeBuilder({ page }).include('dialog[open]').analyze();
        expect(axe.violations.map((violation) => violation.id)).toEqual([]);

        await search.press('Enter');
        await expect(page).toHaveURL(/\/agents\/grace$/);
        await expect(page.getByRole('heading', { level: 1, name: 'Grace' })).toBeVisible();
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
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

    test(`/agents/${FAKE_AGENT_ID}/chat opens a fresh conversation and meets the UX checks`, async ({
        page,
        visit,
    }) => {
        const report = await visit(`/agents/${FAKE_AGENT_ID}/chat`);
        await expect(page.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('textbox', { name: 'New chat' })).toBeVisible();
        const recent = page.getByRole('navigation', { name: 'Recent chats' });
        await expect(recent.getByRole('link', { name: /Injection demo/ })).toBeVisible();
        await expect(recent.getByRole('link', { name: /Do you ship to Brno\?/ })).toBeVisible();
        expectCleanPage(report);
    });

    test(`/agents/${FAKE_AGENT_ID}/chat/all lists every chat and meets the UX checks`, async ({ page, visit }) => {
        const report = await visit(`/agents/${FAKE_AGENT_ID}/chat/all`);
        await expect(page.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
        const table = page.getByRole('table');
        await expect(table.getByRole('link', { name: 'Injection demo' })).toBeVisible();
        await expect(table.getByRole('link', { name: 'Do you ship to Brno?' })).toBeVisible();
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

    test('/runs lists runs across agents, restores its filters from the URL and meets the UX checks', async ({
        page,
        visit,
    }) => {
        const report = await visit('/runs');
        const table = page.getByRole('table');
        await expect(table.getByRole('link', { name: 'Summarise open pull requests' })).toBeVisible();
        await expect(table.getByText('Running', { exact: true })).toBeVisible();
        expectCleanPage(report);

        const filtered = await visit('/runs?status=failed&source=schedule');
        await expect(page.getByRole('checkbox', { name: 'Failed' })).toBeChecked();
        await expect(page.getByRole('combobox', { name: 'Started by' })).toHaveValue('schedule');
        await expect(page.getByRole('table').getByRole('link', { name: 'Write the weekly report' })).toBeVisible();
        expectCleanPage(filtered);
    });

    test(`/agents/${FAKE_AGENT_ID}/runs shows only the agent's runs and meets the UX checks`, async ({
        page,
        visit,
    }) => {
        const report = await visit(`/agents/${FAKE_AGENT_ID}/runs`);
        const table = page.getByRole('table');
        await expect(table.getByRole('link', { name: 'Summarise open pull requests' })).toBeVisible();
        await expect(table.getByRole('link', { name: 'Write the weekly report' })).toHaveCount(0);
        expectCleanPage(report);
    });

    test('/files lists files with hostile names as text, restores its filters and meets the UX checks', async ({
        page,
        visit,
    }) => {
        const report = await visit('/files');
        const table = page.getByRole('table');
        await expect(table.getByRole('link', { name: 'photo.png' })).toBeVisible();
        await expect(table.getByRole('link', { name: HOSTILE_FILE_NAME })).toBeVisible();
        await expect(table.getByText('Infected', { exact: true })).toBeVisible();
        await expect(page.locator('img[src="x"]')).toHaveCount(0);
        expectCleanPage(report);

        const filtered = await visit('/files?scan=infected,failed');
        await expect(page.getByRole('combobox', { name: 'Scan' })).toHaveValue('infected,failed');
        await expect(page.getByRole('table').getByRole('link', { name: 'invoice.png' })).toBeVisible();
        await expect(page.getByRole('table').getByRole('link', { name: 'photo.png' })).toHaveCount(0);
        expectCleanPage(filtered);
    });

    test('the file drawer previews a clean PNG from the engine, offers a plain download and meets the UX checks', async ({
        page,
        visit,
    }) => {
        const report = await visit(`/files?file=${FAKE_FILE_ID}`);
        const drawer = page.getByRole('dialog', { name: 'File details' });
        const preview = drawer.getByRole('img', { name: 'photo.png' });
        await expect(preview).toBeVisible();
        await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
        await expect(drawer.getByRole('link', { name: 'Download photo.png', exact: true })).toHaveAttribute(
            'href',
            `${ENGINE_API_PREFIX}/files/${FAKE_FILE_ID}/content`,
        );
        expectCleanPage(report);

        const infected = await visit('/files?file=file-infected');
        const infectedDrawer = page.getByRole('dialog', { name: 'File details' });
        await expect(infectedDrawer.getByRole('button', { name: 'Download invoice.png', exact: true })).toHaveAttribute(
            'aria-disabled',
            'true',
        );
        await expect(infectedDrawer.locator('img, iframe, object, embed')).toHaveCount(0);
        expectCleanPage(infected);
    });

    test(`/agents/${FAKE_AGENT_ID}/files shows knowledge with the upload control, then outputs, and meets the UX checks`, async ({
        page,
        visit,
    }) => {
        const report = await visit(`/agents/${FAKE_AGENT_ID}/files`);
        await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('table').getByRole('link', { name: 'notes.md' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
        expectCleanPage(report);

        const outputs = await visit(`/agents/${FAKE_AGENT_ID}/files?section=other`);
        await expect(page.getByRole('table').getByRole('link', { name: 'photo.png' })).toBeVisible();
        expectCleanPage(outputs);
    });

    test(`/runs/${FAKE_RUN_ID} keeps agent output inert, keeps Cancel in reach at 360 px and meets the UX checks`, async ({
        page,
        visit,
    }) => {
        const report = await visit(`/runs/${FAKE_RUN_ID}`);
        await expect(page.getByRole('heading', { level: 1, name: 'Summarise open pull requests' })).toBeVisible();
        await page.getByText('github.list_pull_requests').click();
        const tools = page.getByRole('region', { name: 'Tool calls' });
        await expect(tools.locator('pre')).toContainText(HOSTILE_RUN_TEXT);
        const diff = page.getByRole('region', { name: 'Diff of site' });
        await expect(diff.getByText(`+${HOSTILE_RUN_TEXT}`, { exact: true })).toBeVisible();
        expect(await page.locator('main img, main script, main iframe, main object, main embed').count()).toBe(0);
        expect(await page.locator('main a[href^="javascript:"]').count()).toBe(0);
        expectCleanPage(report);

        await page.setViewportSize({ width: 360, height: 740 });
        await page.mouse.wheel(0, 400);
        const cancel = page.getByRole('button', { name: 'Cancel run' });
        await expect(cancel).toBeInViewport();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        ).toBeLessThanOrEqual(0);
        await cancel.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByText('Cancelling…').first()).toBeVisible();
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
    });

    test('/triggers restores its filters from the URL, keeps pause and resume in reach at 360 px and meets the UX checks', async ({
        page,
        visit,
    }) => {
        const report = await visit('/triggers');
        const table = page.getByRole('table');
        await expect(table.getByRole('link', { name: 'Support inbox' })).toBeVisible();
        await expect(table.getByText('Every weekday at 08:00, Europe/Prague')).toBeVisible();
        expectCleanPage(report);

        const filtered = await visit('/triggers?lifecycle=paused');
        await expect(page.getByRole('combobox', { name: 'State' })).toHaveValue('paused');
        await expect(page.getByRole('table').getByRole('link', { name: 'Every quarter hour' })).toBeVisible();
        await expect(page.getByRole('table').getByRole('link', { name: 'Support inbox' })).toHaveCount(0);
        expectCleanPage(filtered);

        await visit('/triggers');
        await page.setViewportSize({ width: 360, height: 740 });
        const pause = page.getByRole('button', { name: 'Pause Support inbox' });
        await pause.scrollIntoViewIfNeeded();
        await expect(pause).toBeInViewport();
        const resume = page.getByRole('button', { name: 'Resume Every quarter hour' });
        await resume.scrollIntoViewIfNeeded();
        await expect(resume).toBeInViewport();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        ).toBeLessThanOrEqual(0);
        await pause.click();
        await expect(page.getByRole('button', { name: 'Resume Support inbox' })).toBeVisible();
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
    });

    test(`/triggers/${FAKE_TRIGGER_ID} keeps the planned message and fire errors inert, keeps Pause in reach at 360 px and meets the UX checks`, async ({
        page,
        visit,
    }) => {
        const report = await visit(`/triggers/${FAKE_TRIGGER_ID}`);
        await expect(page.getByText('Every weekday at 08:00, Europe/Prague')).toBeVisible();
        await expect(page.getByText(`Write the morning report. ${HOSTILE_RUN_TEXT}`)).toBeVisible();
        const fires = page.getByRole('table', { name: 'Fire history' });
        await expect(fires.getByText(`Nothing ran: ${HOSTILE_RUN_TEXT}`)).toBeVisible();
        await expect(fires.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', `/runs/${FAKE_RUN_ID}`);
        expect(await page.locator('main img, main script, main iframe, main object, main embed').count()).toBe(0);
        expect(await page.locator('main a[href^="javascript:"]').count()).toBe(0);
        expectCleanPage(report);

        await page.setViewportSize({ width: 360, height: 740 });
        await page.mouse.wheel(0, 400);
        await expect(page.getByRole('button', { name: /^Pause Morning report/ })).toBeInViewport();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        ).toBeLessThanOrEqual(0);
    });

    test('/triggers/new previews a schedule as an estimate and meets the UX checks', async ({ page, visit }) => {
        const report = await visit('/triggers/new');
        await page.getByRole('combobox', { name: /^Agent/ }).selectOption(FAKE_AGENT_ID);
        await page.getByRole('textbox', { name: /^Name/ }).fill('Weekly digest');
        await page.getByRole('combobox', { name: /^Time zone/ }).selectOption('Europe/Prague');
        await page.getByRole('textbox', { name: /^Cron expression/ }).fill('*/15 * * * *');
        const preview = page.getByRole('region', { name: 'Next fires' });
        await expect(preview.getByText('Every 15 minutes, Europe/Prague')).toBeVisible();
        await expect(preview.getByRole('listitem')).toHaveCount(5);
        await expect(page.getByRole('combobox', { name: /^Kind/ }).locator('option[value="webhook"]')).toBeDisabled();
        expectCleanPage(report);
    });

    test('/integrations lists integrations, restores its filters from the URL and meets the UX checks', async ({
        page,
        visit,
    }) => {
        const report = await visit('/integrations');
        const table = page.getByRole('table');
        await expect(table.getByRole('link', { name: 'Billing repository' })).toBeVisible();
        await expect(table.getByText('Needs attention', { exact: true })).toBeVisible();
        expectCleanPage(report);

        const filtered = await visit('/integrations?status=needs-attention,error');
        await expect(page.getByRole('checkbox', { name: 'Error' })).toBeChecked();
        await expect(page.getByRole('table').getByRole('link', { name: 'Calendar' })).toBeVisible();
        await expect(page.getByRole('table').getByRole('link', { name: /^Documentation search/ })).toHaveCount(0);
        expectCleanPage(filtered);
    });

    test(`/integrations/${FAKE_INTEGRATION_ID} keeps third-party text inert and meets the UX checks`, async ({
        page,
        visit,
    }) => {
        const report = await visit(`/integrations/${FAKE_INTEGRATION_ID}`);
        await expect(page.getByRole('heading', { level: 1, name: /^Documentation search/ })).toBeVisible();
        const tools = page.getByRole('region', { name: 'Tools' });
        await expect(tools.getByText(HOSTILE_TOOL_TEXT, { exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Secrets it uses' }).getByRole('link')).toHaveAttribute(
            'href',
            '/secrets?q=GITHUB_TOKEN',
        );
        expect(await page.locator('main img, main script, main iframe, main object, main embed').count()).toBe(0);
        expect(await page.locator('main a[href^="javascript:"]').count()).toBe(0);
        expectCleanPage(report);
    });

    test('the add MCP server dialog loads its form under the CSP and asks for no secret value', async ({
        page,
        visit,
    }) => {
        const report = await visit('/integrations');
        await expect(page.getByRole('table').getByRole('link', { name: 'Billing repository' })).toBeVisible();
        await page.getByRole('button', { name: 'Add MCP server' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add MCP server' });
        await expect(dialog.getByRole('checkbox', { name: 'GITHUB_TOKEN' })).toBeVisible();
        expect(await page.locator('input[type="password"]').count()).toBe(0);
        await dialog.getByRole('textbox', { name: /^Name/ }).fill('Search');
        await dialog.getByRole('textbox', { name: /^Server URL/ }).fill('https://search.example.com/mcp');
        await dialog.getByRole('checkbox', { name: 'GITHUB_TOKEN' }).check();
        await dialog.getByRole('button', { name: 'Add' }).click();
        await expect(page.getByText('Search added')).toBeVisible();
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
        expectCleanPage(report);
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
