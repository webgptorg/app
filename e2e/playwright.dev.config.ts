import { defineConfig, devices } from '@playwright/test';

import { DEV_PORTS, chromiumArgs } from './src/dev-stack-config.ts';

// The dev stack's smoke test (X-06), on the host against `bun run dev:stack up --no-system`: Chromium with the same
// arguments the stack prints for a person, except the profile, which Playwright makes itself.
export default defineConfig({
    testDir: './tests/dev-stack',
    outputDir: './test-results/dev-stack/artifacts',
    forbidOnly: process.env['CI'] !== undefined && process.env['CI'] !== '',
    retries: 0,
    workers: 1,
    // Two stack starts (`dev:stack down` and `up` in the middle) and a chat reply.
    timeout: 900_000,
    reporter: [['list'], ['html', { outputFolder: './test-results/dev-stack/report', open: 'never' }]],
    use: {
        ...devices['Desktop Chrome'],
        // `chrome` runs the installed Google Chrome instead of Playwright's Chromium.
        ...(process.env['E2E_DEV_BROWSER_CHANNEL'] ? { channel: process.env['E2E_DEV_BROWSER_CHANNEL'] } : {}),
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: {
            args: chromiumArgs('', DEV_PORTS.noSystemRelay).filter((arg) => !arg.startsWith('--user-data-dir=')),
        },
    },
    projects: [{ name: 'chromium' }],
});
