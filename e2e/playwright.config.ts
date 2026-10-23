import { defineConfig, devices } from '@playwright/test';

import { scenarioNamed } from './src/scenarios.ts';

// cli.ts passes the scenario whose overlays it started; only that scenario's specs can pass against this stack.
const scenario = scenarioNamed(process.env['E2E_SCENARIO']);

// Runs inside the compose network (the `playwright` service), never on the host: names resolve through the stack's
// DNS and Chromium trusts the dev CA through the NSS database the entrypoint prepared.
export default defineConfig({
    testDir: './tests',
    // Globs match absolute paths.
    testMatch: scenario.specs.map((spec) => `**/tests/${spec}`),
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
        // Playwright turns Chromium's sandbox off by default; a renderer bug must not reach a container that holds the
        // Docker socket.
        launchOptions: { chromiumSandbox: true },
    },
    projects: [
        { name: 'chromium' },
        ...((scenario.firefoxSpecs ?? []).length === 0
            ? []
            : [
                  {
                      name: 'firefox',
                      testMatch: (scenario.firefoxSpecs ?? []).map((spec) => `**/tests/${spec}`),
                      use: { ...devices['Desktop Firefox'] },
                  },
              ]),
    ],
});
