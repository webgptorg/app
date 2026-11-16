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
    test("/ is the owner's Chatter-first home with the feed, keeps engine text inert and meets the UX checks", async ({
        page,
        visit,
    }) => {
        const report = await visit('/');

        await expect(page.getByRole('heading', { level: 1, name: /, Owner$/ })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Ask Chatter' })).toBeVisible();
        await expect(page.getByRole('region', { name: /^Needs you( \d+)?$/ })).toBeVisible();
        await expect(page.getByRole('region', { name: /^Working now( \d+)?$/ })).toBeVisible();
        const feed = page.getByRole('region', { name: 'Recent activity' });
        await expect(feed.getByText('deploy.started')).toBeVisible();
        await expect(feed.getByText('Jana Nováková', { exact: true })).toBeVisible();
        await expect(feed.getByRole('link', { name: HOSTILE_AGENT_NAME })).toHaveAttribute(
            'href',
            `/agents/${FAKE_AGENT_ID}`,
        );
        expect(await feed.locator('img, script, iframe').count()).toBe(0);
        expect(await feed.textContent()).not.toContain('javascript:alert(1)');
        expectCleanPage(report);
    });

    test('a new engine opens on its setup, whose prompts render and answer under the CSP', async ({ page, visit }) => {
        await routeFakeEngineApi(page, { onboarding: 'pending' });
        const report = await visit('/');

        await expect(page.getByRole('heading', { level: 1, name: 'Your project' })).toBeVisible();
        await expect(page.getByRole('progressbar')).toBeVisible();
        await page.getByRole('textbox', { name: 'What are you working on?' }).fill('<img src=x onerror=alert(1)>');
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page.getByRole('heading', { level: 1, name: 'Sign in to OpenAI Codex' })).toBeVisible();
        await expect(page.getByText('K7QF-3MRP')).toBeVisible();
        expectCleanPage(report);
    });

    test("/ is a member's home without the activity feed and meets the UX checks", async ({ page, visit }) => {
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
        await expect(page.getByRole('textbox', { name: 'Ask Chatter' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Recent chats' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Recent activity' })).toHaveCount(0);
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
        const grid = await visit('/agents');
        await expect(page.getByRole('button', { name: 'Ada', exact: true })).toBeVisible();
        expectCleanPage(grid);

        const table = await visit('/agents?view=table');
        await expect(page.getByRole('link', { name: 'Ada' })).toBeVisible();
        await expect(page.getByRole('row').filter({ hasText: 'Grace' }).getByText('Jana Nováková')).toBeVisible();
        expectCleanPage(table);
    });

    test(`/agents/${FAKE_AGENT_ID} and its Settings tab meet the UX checks`, async ({ page, visit }) => {
        const overview = await visit(`/agents/${FAKE_AGENT_ID}`);
        await expect(page.getByRole('heading', { level: 1, name: 'Ada' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
        expectCleanPage(overview);

        const settings = await visit(`/agents/${FAKE_AGENT_ID}/settings`);
        await expect(page.getByRole('combobox', { name: 'Visibility' })).toHaveText('Public');
        expectCleanPage(settings);
    });

    test(`/agents/${FAKE_AGENT_ID} keeps its actions on the title row at 360 px`, async ({ page, visit }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        for (const path of [`/agents/${FAKE_AGENT_ID}`, `/agents/${FAKE_AGENT_ID}/chat`]) {
            expectCleanPage(await visit(path));
            // The title block: on a phone the badges may wrap under the name, and the actions centre on both lines.
            const title = await page.getByRole('heading', { level: 1 }).locator('..').boundingBox();
            const more = await page.getByRole('button', { name: 'More actions' }).boundingBox();
            expect(title).not.toBeNull();
            expect(more).not.toBeNull();
            const middle = (more?.y ?? 0) + (more?.height ?? 0) / 2;
            expect(middle).toBeGreaterThanOrEqual(title?.y ?? Infinity);
            expect(middle).toBeLessThanOrEqual((title?.y ?? 0) + (title?.height ?? 0));
        }
    });

    test(`/agents/${FAKE_AGENT_ID} gives run and integration names a line of their own at 360 px`, async ({
        page,
        visit,
    }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        expectCleanPage(await visit(`/agents/${FAKE_AGENT_ID}`));
        for (const name of [
            'Summarise open pull requests',
            'Documentation search with a rather long name that has to wrap',
        ]) {
            const link = page.getByRole('link', { name, exact: true });
            // The row's middle column, between the type icon and the time.
            const middle = await link.locator('xpath=ancestor::li[1]/span[2]').boundingBox();
            const box = await link.boundingBox();
            expect(middle).not.toBeNull();
            expect(box).not.toBeNull();
            // Not squeezed between the status badge and the time: the name may use the whole middle column.
            expect(box?.x ?? Infinity).toBeLessThanOrEqual((middle?.x ?? 0) + 1);
        }
    });

    test(`/agents/${FAKE_AGENT_ID}/chat lists the agent's threads and meets the UX checks`, async ({ page, visit }) => {
        const report = await visit(`/agents/${FAKE_AGENT_ID}/chat`);
        await expect(page.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('button', { name: 'New chat with Ada' })).toBeVisible();
        const table = page.getByRole('table', { name: 'Chats' });
        await expect(table.getByRole('link', { name: 'Injection demo' })).toBeVisible();
        await expect(table.getByRole('link', { name: 'Shipping' })).toBeVisible();
        expectCleanPage(report);
    });

    test('/chats lists every thread, marks the one that needs you and meets the UX checks', async ({ page, visit }) => {
        const report = await visit('/chats');
        const table = page.getByRole('table', { name: 'Chats' });
        await expect(table.getByRole('link', { name: 'Injection demo' })).toBeVisible();
        await expect(table.getByRole('row').filter({ hasText: 'Shipping' }).getByText('Needs you')).toBeVisible();
        expectCleanPage(report);

        const filtered = await visit('/chats?needs=you');
        await expect(page.getByRole('button', { name: 'Attention: Needs you', exact: true })).toBeVisible();
        await expect(
            page.getByRole('table', { name: 'Chats' }).getByRole('link', { name: 'Injection demo' }),
        ).toHaveCount(0);
        expectCleanPage(filtered);
    });

    test('hostile agent output stays inert, before and after sending a message', async ({ page, visit }) => {
        const report = await visit(`/chats/${FAKE_CHAT_ID}`);
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
        await expect(
            page.getByText('A certificate this engine did not request exists for its hostname').first(),
        ).toBeVisible();
        await expect(page.getByTestId('heartbeat-body')).toHaveText(RAW_HEARTBEAT, { useInnerText: false });
        await expect(page.getByText('The UI version does not match')).toHaveCount(0);
        expectCleanPage(report);
    });

    test('/audit shows hostile target names as text, expands by keyboard and meets the UX checks', async ({
        page,
        visit,
    }) => {
        const report = await visit('/audit');
        await expect(page.getByRole('button', { name: /^Chain verified / })).toBeVisible();
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
        await expect(page.getByRole('button', { name: 'Status: Failed', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Source: Schedule', exact: true })).toBeVisible();
        await expect(page.getByRole('table').getByRole('link', { name: 'Write the weekly report' })).toBeVisible();
        expectCleanPage(filtered);
    });

    for (const path of ['/runs', `/agents/${FAKE_AGENT_ID}/runs`]) {
        test(`${path} keeps its filter bar on one scrolling line at 360 px, so the first run is in view`, async ({
            page,
            visit,
        }) => {
            await page.setViewportSize({ width: 360, height: 740 });
            expectCleanPage(await visit(`${path}?source=api&status=failed,running`));
            await expect(page.getByRole('link', { name: 'Summarise open pull requests' })).toBeInViewport();
            // The chips scroll sideways inside the bar rather than clipping or widening the page.
            const bar = page.getByRole('search', { name: 'Filter runs' });
            const chip = bar.getByRole('button', { name: 'Remove Source: API' });
            await chip.scrollIntoViewIfNeeded();
            await expect(chip).toBeInViewport();

            await bar.getByRole('button', { name: 'Filter', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: 'Filter' });
            await dialog.getByRole('option', { name: 'Status' }).click();
            await page.getByRole('dialog', { name: 'Status' }).getByRole('option', { name: 'Queued' }).click();
            await expect(page).toHaveURL(/status=queued%2Crunning%2Cfailed|status=queued,running,failed/);
            await page.keyboard.press('Escape');
            await expect(
                // The counted values are read from a visually hidden node, which Chrome sets apart with a space.
                bar.getByRole('button', { name: /^Status: Queued, Running ?, Failed$/ }),
            ).toBeVisible();
            expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
        });
    }

    for (const [path, bar, first] of [
        ['/triggers', 'Trigger filters', 'Morning report with a long name that has to wrap on a narrow screen'],
        ['/integrations', 'Filter integrations', 'Documentation search with a rather long name that has to wrap'],
        ['/chats', 'Filter chats', 'Injection demo'],
    ] as const) {
        test(`${path} keeps its filter bar on one line at 360 px, so the first item is in view`, async ({
            page,
            visit,
        }) => {
            await page.setViewportSize({ width: 360, height: 740 });
            expectCleanPage(await visit(path));
            await expect(
                page.getByRole('search', { name: bar }).getByRole('button', { name: 'Filter', exact: true }),
            ).toBeVisible();
            await expect(page.getByRole('link', { name: first }).first()).toBeInViewport();
        });
    }

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
        // The counted values are read from a visually hidden node, which Chrome sets apart with a space.
        await expect(page.getByRole('button', { name: /^Scan: Infected ?, Scan failed$/ })).toBeVisible();
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
        const stop = page.getByRole('button', { name: 'Stop' });
        await expect(stop).toBeInViewport();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        ).toBeLessThanOrEqual(0);
        await stop.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByText('Stopping…').first()).toBeVisible();
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
        await expect(page.getByRole('button', { name: 'State: Paused', exact: true })).toBeVisible();
        await expect(page.getByRole('table').getByRole('link', { name: 'Every quarter hour' })).toBeVisible();
        await expect(page.getByRole('table').getByRole('link', { name: 'Support inbox' })).toHaveCount(0);
        expectCleanPage(filtered);

        await visit('/triggers');
        await page.setViewportSize({ width: 360, height: 740 });
        // The table turns into cards on a media query change after the resize; a button found before that is detached.
        await expect(page.getByRole('table')).toHaveCount(0);
        // Pause and resume live in each row's ⋯ menu, which stays on the card at 360 px.
        const supportActions = page.getByRole('button', { name: 'Actions for Support inbox' });
        await supportActions.scrollIntoViewIfNeeded();
        await expect(supportActions).toBeInViewport();
        const quarterActions = page.getByRole('button', { name: 'Actions for Every quarter hour' });
        await quarterActions.scrollIntoViewIfNeeded();
        await expect(quarterActions).toBeInViewport();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        ).toBeLessThanOrEqual(0);
        await supportActions.click();
        await page.getByRole('menuitem', { name: 'Pause' }).click();
        await supportActions.click();
        await expect(page.getByRole('menuitem', { name: 'Resume' })).toBeVisible();
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
    });

    test(`/triggers/${FAKE_TRIGGER_ID} keeps the planned message and fire errors inert, fits its actions into 360 px and meets the UX checks`, async ({
        page,
        visit,
    }) => {
        const report = await visit(`/triggers/${FAKE_TRIGGER_ID}`);
        await expect(page.getByText('Every weekday at 08:00, Europe/Prague')).toBeVisible();
        await expect(page.getByText(`Write the morning report. ${HOSTILE_RUN_TEXT}`)).toBeVisible();
        const fires = page.getByRole('table', { name: 'History' });
        await expect(fires.getByText(`Nothing ran: ${HOSTILE_RUN_TEXT}`)).toBeVisible();
        await expect(fires.getByRole('link', { name: 'Run', exact: true })).toHaveAttribute(
            'href',
            `/runs/${FAKE_RUN_ID}`,
        );
        expect(await page.locator('main img, main script, main iframe, main object, main embed').count()).toBe(0);
        expect(await page.locator('main a[href^="javascript:"]').count()).toBe(0);
        expectCleanPage(report);

        // Narrow, the page header scrolls away with the page (the phone keeps its own bar), so Pause is in its menu up top.
        await page.setViewportSize({ width: 360, height: 740 });
        await page.getByRole('button', { name: 'More actions' }).click();
        await expect(page.getByRole('menuitem', { name: 'Pause' })).toBeInViewport();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        ).toBeLessThanOrEqual(0);
    });

    test('/triggers/new previews a schedule as an estimate and meets the UX checks', async ({ page, visit }) => {
        const report = await visit('/triggers/new');
        const choose = async (field: RegExp, option: string) => {
            await page.getByRole('combobox', { name: field }).click();
            await page.getByRole('option', { name: option, exact: true }).click();
        };
        await choose(/^Agent/, 'Ada');
        await page.getByRole('textbox', { name: /^Name/ }).fill('Weekly digest');
        await choose(/^Time zone/, 'Europe/Prague');
        await choose(/^Repeats/, 'Custom (cron)');
        await page.getByRole('textbox', { name: /^Cron expression/ }).fill('*/15 * * * *');
        const preview = page.getByRole('region', { name: 'Next runs' });
        await expect(preview.getByText('Every 15 minutes, Europe/Prague')).toBeVisible();
        await expect(preview.getByRole('listitem')).toHaveCount(5);
        await page.getByRole('combobox', { name: /^Kind/ }).click();
        await expect(page.getByRole('option', { name: /^Webhook/ })).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
        expectCleanPage(report);
    });

    test('a cold load of /triggers/new takes its first click at once', async ({ page, visit }) => {
        expectCleanPage(await visit('/settings'));
        // No waiting for the network: a route transition over the first load would swallow this click.
        await page.goto('/triggers/new');
        await page.getByRole('combobox', { name: /^Kind/ }).click();
        await expect(page.getByRole('option', { name: 'Schedule', exact: true })).toBeVisible();
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
        await expect(page.getByRole('button', { name: /^Status: Needs attention ?, Error$/ })).toBeVisible();
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
        await expect(page.getByRole('region', { name: 'Secrets it uses' }).getByText('GITHUB_TOKEN')).toBeVisible();
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
        await page.getByRole('button', { name: 'Add integration' }).click();
        await page.getByRole('menuitem', { name: 'MCP server' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add MCP server' });
        expect(await page.locator('input[type="password"]').count()).toBe(0);
        await dialog.getByRole('textbox', { name: /^Name/ }).fill('Search');
        await dialog.getByRole('textbox', { name: /^Server URL/ }).fill('https://search.example.com/mcp');
        await dialog.getByRole('textbox', { name: /^Secrets it uses/ }).fill('GITHUB_TOKEN');
        await dialog.getByRole('button', { name: 'Add' }).click();
        await expect(page.getByText('Search added.')).toBeVisible();
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
        expectCleanPage(report);
    });

    test('/audit restores its filters from the URL and meets the UX checks', async ({ page, visit }) => {
        const report = await visit('/audit?outcome=denied&from=2026-09-01&to=2026-09-03');
        await expect(page.getByRole('button', { name: 'Outcome: Denied', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /^Date: / })).toBeVisible();
        await expect(page.getByRole('table')).toBeVisible();
        expectCleanPage(report);
    });

    test('the Wallet login form loads under the CSP, reveals only inside it and keeps the password out', async ({
        page,
        visit,
    }) => {
        const report = await visit('/wallet');
        // The row names the site once, with the account under it, instead of the engine's "site · account" label.
        await expect(
            page.getByRole('region', { name: 'Saved logins' }).getByRole('listitem').filter({ hasText: 'github.com' }),
        ).toBeVisible();
        await expect(page.getByText('Ada needs a login for linear.app')).toBeVisible();

        await page.getByRole('button', { name: 'Add login' }).last().click();
        const dialog = page.getByRole('dialog', { name: 'Add login' });
        await expect(dialog.getByRole('textbox', { name: /^Website/ })).toHaveValue('https://linear.app');
        await dialog.getByRole('textbox', { name: /^Username or email/ }).fill('ada@example.com');
        const password = dialog.getByLabel(/^Password/);
        await password.fill('csp-canary-password');
        await expect(password).toHaveAttribute('type', 'password');
        await dialog.getByRole('button', { name: 'Show' }).click();
        await expect(password).toHaveAttribute('type', 'text');
        await expect(password).toHaveValue('csp-canary-password');
        await dialog.getByRole('button', { name: 'Save login' }).click();
        await expect(page.getByText('Login for linear.app saved. The waiting work continues.')).toBeVisible();
        expect(await page.content()).not.toContain('csp-canary-password');
        expectCleanPage(report);
    });

    test('row actions and the delete dialog work by keyboard and return focus', async ({ page, visit }) => {
        expectCleanPage(await visit('/agents?view=table'));
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
            page.on('request', (request) => {
                const url = new URL(request.url());
                requested.push(`${url.pathname}${url.search}`);
            });
            const loaded = new Set(requested);

            const link = page.getByRole('link', { name: 'Agents', exact: true });
            if (intent === 'hover') await link.hover();
            else await link.focus();

            // Two lists, the member's own agents and the built-in ones, each asked for once.
            const agentLists = () => requested.filter((path) => path.startsWith(`${ENGINE_API_PREFIX}/agents?`));
            await expect.poll(() => agentLists()).toHaveLength(2);
            expect(new Set(agentLists()).size).toBe(2);
            await expect
                .poll(() => requested.filter((path) => /\.js(\?|$)/.test(path) && !loaded.has(path)).length)
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
