import { defineConfig } from '@playwright/test';

// The spec starts the engine, a relay and its SNI passthrough in-process, so there is no web server to configure.
export default defineConfig({
    testDir: './test/browser',
    forbidOnly: process.env['CI'] !== undefined,
    retries: 0,
    reporter: 'list',
    timeout: 60_000,
    use: { trace: 'retain-on-failure' },
});
