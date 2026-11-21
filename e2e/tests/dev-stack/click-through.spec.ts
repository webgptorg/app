import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { commonName } from '../../src/certificates.ts';
import { DEV_CA_CERT_FILE, DEV_DASHBOARD_ORIGIN, DEV_ENGINE_DOMAIN } from '../../src/dev-stack-config.ts';
import {
    REPO_ROOT,
    addPasskeyAuthenticator,
    bunRun,
    collectCspViolations,
    devStackEngine,
    engineRow,
    expectEngineListed,
    pageCertificate,
    signUpAndSubscribe,
    takeLinkCode,
} from '../../src/dev-smoke.ts';

// X-06's automated click-through, the `--no-system` path: what a person does in their browser, with a virtual
// authenticator instead of Touch ID, against a fresh `bun run dev:stack up --no-system` (the engine must not be linked
// yet). The engine is linked by running the install command the dashboard shows, `bun run dev:link <code>`.

const ONLINE_WITHIN_MS = 90_000;

test.skip(devStackEngine() !== 'mock', 'the stack runs the real engine: real-engine.spec.ts is its smoke test');

test('sign up from the dev mailbox, subscribe, link with dev:link, open the engine, sign in and chat', async ({
    page,
}) => {
    const violations = await collectCspViolations(page.context());
    await addPasskeyAuthenticator(page);
    const email = `x06-smoke-${String(Date.now())}@example.test`;
    await signUpAndSubscribe(page, email);

    const code = await takeLinkCode(page);
    const linked = await bunRun('dev:link', code);
    expect(linked.output, 'run against a fresh stack: bun run dev:stack reset').not.toContain('already linked');
    expect(linked.exitCode, linked.output).toBe(0);

    const row = engineRow(page);
    await expectEngineListed(page, ['Online'], ONLINE_WITHIN_MS);

    const [enginePage, response] = await Promise.all([
        page.context().waitForEvent('page'),
        page.context().waitForEvent('response', (candidate) => candidate.url().includes(`.${DEV_ENGINE_DOMAIN}/`)),
        row.getByRole('link', { name: /^Open engine/ }).click(),
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
    await expect(page.getByRole('heading', { name: 'Sign in or create an account' })).toBeVisible();
    const down = await bunRun('dev:stack', 'down');
    expect(down.exitCode, down.output).toBe(0);
    const up = await bunRun('dev:stack', 'up', '--no-system');
    expect(up.exitCode, up.output).toBe(0);
    expect(up.output).toContain(`engine       https://${engineHost}/`);
    await page.goto(`${DEV_DASHBOARD_ORIGIN}/signin`);
    await page.getByLabel('Email').fill(email);
    // The passkey autofill may sign in before "Use a passkey" can be clicked (see e2e/src/dashboard.ts).
    await page
        .getByRole('button', { name: 'Use a passkey' })
        .click({ timeout: 5_000 })
        .catch(() => undefined);
    await expect(page.getByRole('heading', { name: 'Engines', level: 1 })).toBeVisible();
    await page.goto(`${DEV_DASHBOARD_ORIGIN}/engines/all`);
    await expectEngineListed(page, ['Online'], ONLINE_WITHIN_MS);
    await expect(row.getByText(engineHost, { exact: true })).toBeVisible();

    expect(violations).toEqual([]);
});
