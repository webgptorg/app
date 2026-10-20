import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { ENGINE_UI_CSP } from '@ptbk/engine-api';
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { CspViolation } from '../../src/security/csp-violation-listener.ts';
import { routeFakeEngineApi } from './fake-engine-api.ts';

export { expect };

const NARROW_VIEWPORT = { width: 360, height: 740 } as const;
const MAX_LAYOUT_SHIFT = 0.1;

/** Everything `visit()` observed; `expectCleanPage()` holds it to the bar every engine-ui route must meet. */
export interface PageReport {
    /** Recorded by the bundle's own listener into `window.__ptbkCspViolations`. */
    readonly cspViolations: readonly CspViolation[];
    /** Console errors, including the browser's CSP and Trusted Types reports (also those before the bundle runs). */
    readonly consoleErrors: readonly string[];
    readonly pageErrors: readonly string[];
    /** Requests to anything but the page's own origin. */
    readonly foreignRequests: readonly string[];
    /** axe-core violations of serious or critical impact. */
    readonly axeViolations: readonly string[];
    /** How far the page scrolls sideways at 360 × 740; 0 when it fits. */
    readonly overflowPx: number;
    /** Cumulative layout shift after load. */
    readonly layoutShift: number;
}

export function expectCleanPage(report: PageReport): void {
    expect.soft(report.cspViolations, 'CSP violations').toEqual([]);
    expect.soft(report.consoleErrors, 'console errors').toEqual([]);
    expect.soft(report.pageErrors, 'uncaught page errors').toEqual([]);
    expect.soft(report.foreignRequests, 'requests to other origins').toEqual([]);
    expect.soft(report.axeViolations, 'serious or critical axe violations').toEqual([]);
    expect.soft(report.overflowPx, 'horizontal overflow at 360 px').toBeLessThanOrEqual(0);
    expect.soft(report.layoutShift, 'cumulative layout shift').toBeLessThan(MAX_LAYOUT_SHIFT);
}

interface Fixtures {
    /** Loads `path`, waits for the app to settle and reports what it observed. */
    visit: (path: string) => Promise<PageReport>;
    /** Serves `html` at `path` under the engine's CSP, for negative tests that must make `visit()` fail. */
    serveFixturePage: (path: string, html: string) => Promise<void>;
}

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

/** The built index.html, to derive fixture pages that load the real bundle. */
export function readBuiltIndexHtml(): Promise<string> {
    return readFile(join(distDir, 'index.html'), 'utf8');
}

export const test = base.extend<Fixtures>({
    page: async ({ page }, use) => {
        await routeFakeEngineApi(page);
        // Defined before any page script runs; the bundle's listener appends to it (csp-violation-listener.ts).
        await page.addInitScript(() => {
            window.__ptbkCspViolations = [];
        });
        await use(page);
    },

    serveFixturePage: async ({ page }, use) => {
        await use(async (path, html) => {
            await page.route(
                (url) => `${url.pathname}${url.search}` === path,
                (route) =>
                    route.fulfill({
                        status: 200,
                        contentType: 'text/html',
                        headers: { 'content-security-policy': ENGINE_UI_CSP },
                        body: html,
                    }),
            );
        });
    },

    visit: async ({ page, baseURL }, use) => {
        const origin = new URL(baseURL ?? '').origin;
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const foreignRequests: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('request', (request) => {
            if (new URL(request.url()).origin !== origin) foreignRequests.push(request.url());
        });

        await use(async (path) => {
            const response = await page.goto(path);
            expect(response?.headers()['content-security-policy'], 'served under the engine CSP').toBe(ENGINE_UI_CSP);
            await page.waitForLoadState('networkidle');
            // Read before axe runs: axe is test tooling injected over CDP, not part of the bundle.
            const cspViolations = await page.evaluate(() => window.__ptbkCspViolations ?? []);
            const layoutShift = await measureLayoutShift(page);
            const axe = await new AxeBuilder({ page }).analyze();
            const axeViolations = axe.violations
                .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
                .map(
                    (violation) =>
                        `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
                );
            const overflowPx = await measureOverflow(page);
            return {
                cspViolations,
                consoleErrors: [...consoleErrors],
                pageErrors: [...pageErrors],
                foreignRequests: [...foreignRequests],
                axeViolations,
                overflowPx,
                layoutShift,
            };
        });
    },
});

async function measureLayoutShift(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            new Promise<number>((resolve) => {
                const observer = new PerformanceObserver(() => undefined);
                observer.observe({ type: 'layout-shift', buffered: true });
                // Buffered entries land in the observer's buffer synchronously; one frame lets late shifts in too.
                requestAnimationFrame(() => {
                    const entries = observer.takeRecords() as (PerformanceEntry & {
                        readonly value: number;
                        readonly hadRecentInput: boolean;
                    })[];
                    observer.disconnect();
                    resolve(
                        entries.filter((entry) => !entry.hadRecentInput).reduce((sum, entry) => sum + entry.value, 0),
                    );
                });
            }),
    );
}

async function measureOverflow(page: Page): Promise<number> {
    const viewport = page.viewportSize();
    await page.setViewportSize(NARROW_VIEWPORT);
    const overflow = await page.evaluate(
        (width) =>
            new Promise<number>((resolve) => {
                requestAnimationFrame(() => {
                    resolve(document.documentElement.scrollWidth - width);
                });
            }),
        NARROW_VIEWPORT.width,
    );
    if (viewport !== null) await page.setViewportSize(viewport);
    return overflow;
}
