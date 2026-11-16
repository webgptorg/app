import { defineConfig, devices } from '@playwright/test';

const port = 4173;
// A headless Chrome on macOS otherwise asks the login keychain for its "Safe Storage" key, a popup on the developer's
// screen; these keep its secrets in memory instead.
const launchOptions = { args: ['--use-mock-keychain', '--password-store=basic'] };

export default defineConfig({
    testDir: './test/csp',
    forbidOnly: process.env['CI'] !== undefined,
    retries: 0,
    reporter: 'list',
    use: { baseURL: `http://127.0.0.1:${String(port)}`, trace: 'retain-on-failure' },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions } },
        {
            name: 'chromium-reduced-motion',
            use: { ...devices['Desktop Chrome'], launchOptions, contextOptions: { reducedMotion: 'reduce' } },
        },
    ],
    // `vite preview` serves dist/ with the engine's CSP header (vite.config.ts), as the engine's loader would.
    webServer: {
        command: `vite preview --configLoader runner --host 127.0.0.1 --port ${String(port)} --strictPort`,
        url: `http://127.0.0.1:${String(port)}`,
        reuseExistingServer: false,
    },
});
