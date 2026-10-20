import { ENGINE_API_PREFIX } from '@ptbk/engine-api';

import { expect, expectCleanPage, readBuiltIndexHtml, test } from './fixtures.ts';

test.describe('the built bundle under the engine CSP', () => {
    test('/ redirects to the agents route and runs without a violation', async ({ page, visit }) => {
        const report = await visit('/');

        await expect(page).toHaveURL(/\/agents\?sort=name$/);
        await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
        expectCleanPage(report);
    });

    test('/agents loads its data and meets the UX checks', async ({ page, visit }) => {
        const report = await visit('/agents');

        await expect(page.getByRole('listitem').filter({ hasText: 'Ada' })).toBeVisible();
        expectCleanPage(report);
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
