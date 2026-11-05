import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

import { commonName, leafFromCdpChain } from '../../src/certificates.ts';
import { DEV_CA_CERT_FILE, DEV_DASHBOARD_ORIGIN, DEV_ENGINE_DOMAIN } from '../../src/dev-stack-config.ts';

// X-06's automated click-through, the `--no-system` path: what a person does in their browser, with a virtual
// authenticator instead of Touch ID, against a fresh `bun run dev:stack up --no-system` (the engine must not be linked
// yet). The engine is linked by running the install command the dashboard shows, `bun run dev:link <code>`.

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const INSTALL_COMMAND = /^bun run dev:link ([a-z2-7]{26})$/;
const ONLINE_WITHIN_MS = 90_000;
const CSP_BINDING = '__ptbkDevCspViolation';

interface CspViolation {
    readonly directive: string;
    readonly blockedUri: string;
}

/** Every `securitypolicyviolation` of every page in the context, the engine's tab included. */
async function collectCspViolations(context: BrowserContext): Promise<readonly CspViolation[]> {
    const violations: CspViolation[] = [];
    await context.exposeBinding(CSP_BINDING, (_source, violation: CspViolation) => {
        violations.push(violation);
    });
    await context.addInitScript((binding) => {
        document.addEventListener('securitypolicyviolation', (event) => {
            const report = (window as unknown as Record<string, (violation: unknown) => void>)[binding];
            report?.({ directive: event.effectiveDirective, blockedUri: event.blockedURI });
        });
    }, CSP_BINDING);
    return violations;
}

async function addPasskeyAuthenticator(page: Page): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
}

/** `bun run <script> <args>` from the checkout, as a person types it: the install command, `dev:stack down`. */
function bunRun(...args: readonly string[]): Promise<{ readonly exitCode: number; readonly output: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn('bun', ['run', ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.once('error', reject);
        child.once('close', (exitCode) => {
            resolve({ exitCode: exitCode ?? 1, output: Buffer.concat(chunks).toString('utf8') });
        });
    });
}

/** The certificate Chromium accepted for the page, read through CDP (the page is reloaded under `Network.enable`). */
/** The engine list, fetched anew until the one engine shows as online (heartbeats every 15 s in the dev stack). */
async function expectEngineOnline(page: Page): Promise<void> {
    const engineRow = page.getByRole('row').filter({ hasText: `.${DEV_ENGINE_DOMAIN}` });
    await expect
        .poll(
            async () => {
                await page.goto(`${DEV_DASHBOARD_ORIGIN}/engines/all`);
                await expect(engineRow.or(page.getByText('No engines yet', { exact: true })).first()).toBeVisible();
                return engineRow.getByText('Online', { exact: true }).count();
            },
            { timeout: ONLINE_WITHIN_MS, intervals: [2_000, 5_000] },
        )
        .toBe(1);
}

async function pageCertificate(page: Page): Promise<X509Certificate> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await page.reload();
    const { tableNames } = await cdp.send('Network.getCertificate', { origin: new URL(page.url()).origin });
    await cdp.detach();
    return leafFromCdpChain(tableNames);
}

test('sign up from the dev mailbox, subscribe, link with dev:link, open the engine, sign in and chat', async ({
    page,
}) => {
    const violations = await collectCspViolations(page.context());
    await addPasskeyAuthenticator(page);
    const email = `x06-smoke-${String(Date.now())}@example.test`;

    await page.goto(`${DEV_DASHBOARD_ORIGIN}/signup`);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send the link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    await page.goto(`${DEV_DASHBOARD_ORIGIN}/__dev/mailbox`);
    const message = page.getByRole('listitem').filter({ hasText: `To ${email}` });
    await message.getByRole('link', { name: /\/signup#/ }).click();
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Engines', level: 1 })).toBeVisible();

    await page.getByRole('link', { name: 'Billing' }).click();
    await page.getByRole('button', { name: 'Start your 14-day trial of Standard' }).click();
    await expect(page.getByText('Thank you, your subscription is starting')).toBeVisible();

    await page.goto(`${DEV_DASHBOARD_ORIGIN}/engines/new`);
    const command = page.getByText(/^bun run dev:link /);
    await expect(command).toBeVisible();
    const code = INSTALL_COMMAND.exec((await command.textContent()) ?? '')?.[1];
    if (code === undefined) throw new Error('the dashboard shows no dev:link install command');
    const linked = await bunRun('dev:link', code);
    expect(linked.output, 'run against a fresh stack: bun run dev:stack reset').not.toContain('already linked');
    expect(linked.exitCode, linked.output).toBe(0);

    const engineRow = page.getByRole('row').filter({ hasText: `.${DEV_ENGINE_DOMAIN}` });
    await expectEngineOnline(page);

    const [enginePage, response] = await Promise.all([
        page.context().waitForEvent('page'),
        page.context().waitForEvent('response', (candidate) => candidate.url().includes(`.${DEV_ENGINE_DOMAIN}/`)),
        engineRow.getByRole('link', { name: /^Open engine/ }).click(),
    ]);
    await enginePage.waitForLoadState('load');
    const engineHost = new URL(enginePage.url()).hostname;
    expect(engineHost.endsWith(`.${DEV_ENGINE_DOMAIN}`)).toBe(true);
    expect(await response.headerValue('content-security-policy')).toContain("require-trusted-types-for 'script'");

    // Through relay-a, the engine's own certificate: its hostname, issued by the persistent dev CA.
    const certificate = await pageCertificate(enginePage);
    const ca = new X509Certificate(await readFile(join(REPO_ROOT, DEV_CA_CERT_FILE)));
    expect(certificate.checkIssued(ca) && certificate.verify(ca.publicKey)).toBe(true);
    expect(commonName(certificate.subject) ?? certificate.subjectAltName).toContain(engineHost);

    await expect(enginePage.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await enginePage.getByRole('listitem').first().getByRole('button').click();
    await expect(enginePage.locator('html[data-ui-version]')).toBeAttached();

    await enginePage.goto(`https://${engineHost}/agents`);
    await enginePage.getByRole('table', { name: 'Agents' }).getByRole('link').first().click();
    await enginePage.getByRole('tab', { name: 'Chat' }).click();
    await enginePage.getByRole('button', { name: /^New chat with / }).click();
    const composer = enginePage.getByRole('textbox', { name: 'Message' });
    await composer.fill('Hello from the dev stack smoke test');
    await composer.press('Enter');
    await expect(enginePage.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveText(/ replied$/, {
        timeout: 60_000,
    });
    const messages = enginePage.getByRole('region', { name: 'Messages' }).getByRole('article');
    await expect(messages.first()).toContainText('Hello from the dev stack smoke test');
    await expect(messages).toHaveCount(2);

    // `down` and `up` keep the account, its passkey and the linked engine (the fake billing state is in memory and
    // goes, as accepted). Signed out first, so the way back in is the passkey.
    await enginePage.close();
    await page.goto(`${DEV_DASHBOARD_ORIGIN}/engines/all`);
    await page.getByRole('button', { name: /^Account menu for / }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    const down = await bunRun('dev:stack', 'down');
    expect(down.exitCode, down.output).toBe(0);
    const up = await bunRun('dev:stack', 'up', '--no-system');
    expect(up.exitCode, up.output).toBe(0);
    expect(up.output).toContain(`engine       https://${engineHost}/`);
    await page.goto(`${DEV_DASHBOARD_ORIGIN}/signin`);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Engines', level: 1 })).toBeVisible();
    await page.goto(`${DEV_DASHBOARD_ORIGIN}/engines/all`);
    await expectEngineOnline(page);
    await expect(engineRow.getByText(engineHost, { exact: true })).toBeVisible();

    expect(violations).toEqual([]);
});
