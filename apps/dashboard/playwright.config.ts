import { defineConfig, devices } from '@playwright/test';

import { CSP_TEST_ORIGIN } from './scripts/serve-csp-test.ts';

export default defineConfig({
    testDir: './test/csp',
    forbidOnly: process.env['CI'] !== undefined,
    retries: 0,
    // One server with one D1 and in-memory rate limits; the flows create their own accounts but share the limits.
    workers: 1,
    reporter: 'list',
    use: { baseURL: CSP_TEST_ORIGIN, trace: 'retain-on-failure' },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command: 'node scripts/serve-csp-test.ts',
        url: `${CSP_TEST_ORIGIN}/v1/health`,
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
