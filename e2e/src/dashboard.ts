// Fixtures for the dashboard scenario (X-05): a virtual passkey authenticator, the dashboard's screens as steps, and
// mock engines started from the on-demand `mock-engine` service with what a test learned on the way (a link code).
import type { Locator, TestInfo } from '@playwright/test';

import type { OneOffContainer } from './compose.ts';
import { expect, test as base } from './fixtures.ts';
import { fetchText } from './probe.ts';
import type { OutboxEmail, RegisterReport } from './dashboard-outputs.ts';
import { emailedLink, outboxEmails, parseRegisterReport } from './dashboard-outputs.ts';
import { DASHBOARD_ORIGIN, ENGINE_DOMAIN, MOUNTS } from './stack.ts';

export { expect };
export { isEngineUrl, uniqueEmail } from './dashboard-outputs.ts';

const ENGINE_SERVICE = 'mock-engine';
/** The mock engine's CLI inside its container, for the operator commands a test runs there. */
export const ENGINE_CLI = ['node', '--enable-source-maps', '/app/main.mjs'] as const;
/** Inside the one-off container's own filesystem, so the key is new for every engine and goes away with it. */
const FRESH_DATA_DIR = '/tmp/engine';
const OUTBOX_TIMEOUT_MS = 5_000;
const LINK_CODE = /\b[a-z2-7]{26}\b/;

export interface StartOptions {
    /**
     * `stack`: init's engine key (the `engine` volume, `/pki/engine.json`) at the service's fixed address, so the
     * worker fixtures `engineId` and `engineHost` describe it. `fresh` (default): a key the engine creates for itself.
     */
    readonly key?: 'stack' | 'fresh';
}

export interface MockEngines {
    /** Starts an engine with `linkCode`: it registers, dials the relays it was given and sends heartbeats. */
    start(linkCode: string, options?: StartOptions): Promise<OneOffContainer>;
    /** The mock engine's `register --link` with a fresh key: registers and exits, reporting the outcome. */
    register(linkCode: string): Promise<RegisterReport>;
    /**
     * A fresh engine as an operator first starts it: a new key, no link code and no owner (M-08's first start), so it
     * waits in local mode until `connect --link` runs inside it.
     */
    startUnlinked(): Promise<OneOffContainer>;
}

export interface LinkCodeView {
    readonly installCommand: string;
    readonly linkCode: string;
}

/** The dashboard as a person uses it, in the test's page. */
export interface DashboardSteps {
    readonly origin: string;
    /** Email-first sign-up through the dev outbox; ends signed in on the engine list with a new passkey. */
    signUp(email: string): Promise<void>;
    /** The fake billing provider's Checkout: the account may then link engines. */
    subscribe(): Promise<void>;
    /** Creates a link code on `/engines/new` and reads the install command and the code from the page. */
    createLinkCode(): Promise<LinkCodeView>;
    signOut(): Promise<void>;
    /** Usernameless sign-in with the passkey the authenticator holds. */
    signIn(): Promise<void>;
    /** The engine list's rows once it has loaded, fetched anew (the list refreshes itself only every 60 s). */
    reloadEngineRows(): Promise<Locator>;
    /** Everything the dev outbox holds for `email`, oldest first. */
    emails(email: string): Promise<readonly OutboxEmail[]>;
}

interface DashboardFixtures {
    /** A CTAP2 platform authenticator with resident keys and user verification, added through CDP before the test. */
    authenticator: string;
    dashboard: DashboardSteps;
    mockEngines: MockEngines;
}

async function attachLogs(testInfo: TestInfo, containers: readonly OneOffContainer[]): Promise<void> {
    if (testInfo.status === testInfo.expectedStatus) return;
    for (const container of containers) {
        const logs = await container.logs().catch(() => 'logs unavailable');
        await testInfo.attach(`${container.name}.log`, { body: logs, contentType: 'text/plain' });
    }
}

export const test = base.extend<DashboardFixtures>({
    authenticator: [
        async ({ page }, use) => {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('WebAuthn.enable');
            const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
                options: {
                    protocol: 'ctap2',
                    transport: 'internal',
                    hasResidentKey: true,
                    hasUserVerification: true,
                    isUserVerified: true,
                    automaticPresenceSimulation: true,
                },
            });
            await use(authenticatorId);
            await cdp.detach().catch(() => undefined);
        },
        // Every dashboard test signs up or in with a passkey, so the authenticator exists before any ceremony.
        { auto: true },
    ],

    dashboard: async ({ page, caCertificatePem }, use) => {
        const fetchOutbox = (email: string): Promise<string> =>
            fetchText(
                `${DASHBOARD_ORIGIN}/api/__dev/emails?to=${encodeURIComponent(email)}`,
                caCertificatePem,
                OUTBOX_TIMEOUT_MS,
            );
        const outboxLink = async (email: string, template: string): Promise<string> => {
            let link: string | undefined;
            await expect
                .poll(async () => {
                    link = emailedLink(await fetchOutbox(email), template);
                    return link;
                })
                .toBeDefined();
            if (link === undefined) throw new Error('no emailed link');
            return link;
        };
        const engineList = page.getByRole('heading', { name: 'Your engines' });
        await use({
            origin: DASHBOARD_ORIGIN,
            async signUp(email) {
                await page.goto(`${DASHBOARD_ORIGIN}/signup`);
                await page.getByLabel('Email').fill(email);
                await page.getByRole('button', { name: 'Send the link' }).click();
                await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
                await page.goto(await outboxLink(email, 'signup-link'));
                await page.getByRole('button', { name: 'Create passkey' }).click();
                await expect(engineList).toBeVisible();
            },
            async subscribe() {
                await page.getByRole('link', { name: 'Billing' }).click();
                // The dev plan starts with a trial (D-10); the fake Checkout grants it at once.
                await page.getByRole('button', { name: 'Start your 14-day trial of Standard' }).click();
                await expect(page.getByText('Thank you, your subscription is starting')).toBeVisible();
                await expect(page).toHaveURL(/\/billing$/);
            },
            async createLinkCode() {
                // The page issues the code on load once the organization may link (D-10).
                await page.goto(`${DASHBOARD_ORIGIN}/engines/new`);
                const command = page.getByText(LINK_CODE);
                await expect(command).toBeVisible();
                const installCommand = (await command.textContent()) ?? '';
                const linkCode = installCommand.match(LINK_CODE)?.[0];
                if (linkCode === undefined) throw new Error('no link code in the install command');
                return { installCommand, linkCode };
            },
            async signOut() {
                await page.getByRole('button', { name: /^Account menu for / }).click();
                await page.getByRole('menuitem', { name: 'Sign out' }).click();
                await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
            },
            async signIn() {
                await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
                await expect(engineList).toBeVisible();
            },
            async emails(email) {
                return outboxEmails(await fetchOutbox(email));
            },
            async reloadEngineRows() {
                await page.goto(`${DASHBOARD_ORIGIN}/engines`);
                const rows = page.getByRole('row').filter({ hasText: `.${ENGINE_DOMAIN}` });
                // Loaded: engine rows or the empty state, not the skeleton rows shown while the list loads.
                await expect(rows.first().or(page.getByText('No engines yet', { exact: true }))).toBeVisible();
                return rows;
            },
        });
    },

    mockEngines: async ({ compose }, use, testInfo) => {
        const containers: OneOffContainer[] = [];
        await use({
            async start(linkCode, options = {}) {
                const stack = options.key === 'stack';
                const container = await compose.run(ENGINE_SERVICE, {
                    env: {
                        PTBK_LINK_CODE: linkCode,
                        PTBK_DATA_DIR: stack ? MOUNTS.engine : FRESH_DATA_DIR,
                    },
                    fixedAddress: stack,
                });
                containers.push(container);
                return container;
            },
            async register(linkCode) {
                const container = await compose.run(ENGINE_SERVICE, {
                    env: { PTBK_DATA_DIR: FRESH_DATA_DIR },
                    command: [...ENGINE_CLI, 'register', '--link', linkCode],
                });
                containers.push(container);
                await container.wait();
                return parseRegisterReport(await container.logs('stdout'));
            },
            async startUnlinked() {
                const container = await compose.run(ENGINE_SERVICE, {
                    env: { PTBK_DATA_DIR: FRESH_DATA_DIR, MOCK_PASSKEYS: 'none' },
                });
                containers.push(container);
                return container;
            },
        });
        await attachLogs(testInfo, containers);
        for (const container of containers) await container.remove();
    },
});
