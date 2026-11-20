// The dev stack's smoke tests (tests/dev-stack/, `bun run --filter @ptbk/e2e dev:smoke`): the steps a person takes in
// the `--no-system` Chrome profile and the commands they type, shared by the mock engine's click-through and the real
// engine's (E-03). They run on the host, against the stack `bun run dev:stack up --no-system` started.
import { spawn } from 'node:child_process';
import type { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';

import { leafFromCdpChain } from './certificates.ts';
import type { DevEngine } from './dev-stack-config.ts';
import { DEV_DASHBOARD_ORIGIN, DEV_ENGINE_DOMAIN, DEV_ENGINE_FILE, parseDevEngine } from './dev-stack-config.ts';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');
const INSTALL_COMMAND = /^bun run dev:link ([a-z2-7]{26})$/;
const CSP_BINDING = '__ptbkDevCspViolation';

/** The engine the stack under test runs, as `dev:stack up` recorded it. */
export function devStackEngine(): DevEngine {
    try {
        return parseDevEngine(readFileSync(join(REPO_ROOT, DEV_ENGINE_FILE), 'utf8'));
    } catch {
        return 'mock';
    }
}

export interface CspViolation {
    readonly directive: string;
    readonly blockedUri: string;
}

/** Every `securitypolicyviolation` of every page in the context, the engine's tab included. */
export async function collectCspViolations(context: BrowserContext): Promise<readonly CspViolation[]> {
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

export async function addPasskeyAuthenticator(page: Page): Promise<void> {
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
export function bunRun(...args: readonly string[]): Promise<{ readonly exitCode: number; readonly output: string }> {
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

/** A new account through the dev mailbox, signed in with the page's passkey and subscribed through the fake Checkout. */
export async function signUpAndSubscribe(page: Page, email: string): Promise<void> {
    await page.goto(`${DEV_DASHBOARD_ORIGIN}/continue`);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    await page.goto(`${DEV_DASHBOARD_ORIGIN}/__dev/mailbox`);
    const message = page.getByRole('listitem').filter({ hasText: `To ${email}` });
    await message.getByRole('link', { name: /\/signup#/ }).click();
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Engines', level: 1 })).toBeVisible();

    await page.getByRole('link', { name: 'Billing' }).click();
    await page.getByRole('button', { name: 'Start your 14-day trial of Standard' }).click();
    await expect(page.getByText('Thank you, your subscription is starting')).toBeVisible();
}

/** The link code inside the install command the New engine page shows for the dev stack. */
export async function takeLinkCode(page: Page): Promise<string> {
    await page.goto(`${DEV_DASHBOARD_ORIGIN}/engines/new`);
    const command = page.getByText(/^bun run dev:link /);
    await expect(command).toBeVisible();
    const code = INSTALL_COMMAND.exec((await command.textContent()) ?? '')?.[1];
    if (code === undefined) throw new Error('the dashboard shows no dev:link install command');
    return code;
}

export function engineRow(page: Page): Locator {
    return page.getByRole('row').filter({ hasText: `.${DEV_ENGINE_DOMAIN}` });
}

/** The engine list, fetched anew until the one engine shows one of `states` (the list refreshes only on load). */
export async function expectEngineListed(page: Page, states: readonly string[], timeoutMs: number): Promise<string> {
    const row = engineRow(page);
    let seen = '';
    await expect
        .poll(
            async () => {
                await page.goto(`${DEV_DASHBOARD_ORIGIN}/engines/all`);
                await expect(row.or(page.getByText('No engines yet', { exact: true })).first()).toBeVisible();
                for (const state of states) {
                    if ((await row.getByText(state, { exact: true }).count()) === 1) seen = state;
                }
                return seen;
            },
            { timeout: timeoutMs, intervals: [2_000, 5_000] },
        )
        .not.toBe('');
    return seen;
}

/** The certificate Chromium accepted for the page, read through CDP (the page is reloaded under `Network.enable`). */
export async function pageCertificate(page: Page): Promise<X509Certificate> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await page.reload();
    const { tableNames } = await cdp.send('Network.getCertificate', { origin: new URL(page.url()).origin });
    await cdp.detach();
    return leafFromCdpChain(tableNames);
}
