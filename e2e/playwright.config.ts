import { defineConfig, devices } from '@playwright/test';

// Runs inside the compose network (the `playwright` service), never on the host: names resolve through the stack's
// DNS and Chromium trusts the dev CA through the NSS database the entrypoint prepared.
export default defineConfig({
    testDir: './tests',
    testMatch: '**/*.spec.ts',
    outputDir: './test-results/artifacts',
    forbidOnly: process.env['CI'] !== undefined && process.env['CI'] !== '',
    retries: 0,
    // Later scenarios stop, kill and pause services of the one shared stack, so tests never overlap.
    workers: 1,
    fullyParallel: false,
    timeout: 30_000,
    reporter: [['list'], ['html', { outputFolder: './test-results/report', open: 'never' }]],
    use: {
        ...devices['Desktop Chrome'],
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [{ name: 'chromium' }],
});
