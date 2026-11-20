import { expect, test } from '@playwright/test';

import { DEV_ENGINE_DOMAIN } from '../../src/dev-stack-config.ts';
import {
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

// E-03's click-through with the real engine, against a fresh `bun run dev:stack up --no-system --engine real`: the
// same account steps as the mock's, then the dashboard's install command (`dev:link`, which runs `ptbk init
// --prepare-only` in the engine's container), the engine online through the local relays with its own certificate,
// the owner's setup link and the engine's first page, which is our signed UI when its loader installed the stack's
// release. Run it on a machine where the engine may run: never on a laptop that must not run engine code.

// The engine sends its first heartbeat after registering, then one a minute.
const LISTED_WITHIN_MS = 180_000;
const SETUP_LINK = /setup link {3}(https:\/\/\S+)/;

test.skip(devStackEngine() !== 'real', 'run against `bun run dev:stack up --no-system --engine real`');

test('sign up, link the real engine with dev:link, see it listed, open it and become its owner', async ({
    page,
    context,
}) => {
    const violations = await collectCspViolations(context);
    await addPasskeyAuthenticator(page);
    await signUpAndSubscribe(page, `e03-smoke-${String(Date.now())}@example.test`);

    const code = await takeLinkCode(page);
    const linked = await bunRun('dev:link', code);
    expect(linked.output, 'run against a fresh stack: bun run dev:stack reset').not.toContain('already linked');
    expect(linked.exitCode, linked.output).toBe(0);
    const setupLink = SETUP_LINK.exec(linked.output)?.[1];
    expect(setupLink, linked.output).toBeDefined();
    const engineHost = new URL(setupLink ?? '').hostname;
    expect(engineHost.endsWith(`.${DEV_ENGINE_DOMAIN}`)).toBe(true);

    const state = await expectEngineListed(page, ['Online', 'Setup not finished'], LISTED_WITHIN_MS);
    test.info().annotations.push({ type: 'dashboard state', description: state });
    await expect(engineRow(page).getByText(engineHost, { exact: true })).toBeVisible();

    await test.step('"Open" reaches the engine through relay-a, with its own certificate and the engine CSP', async () => {
        const [opened, response] = await Promise.all([
            context.waitForEvent('page'),
            context.waitForEvent('response', (candidate) => new URL(candidate.url()).hostname === engineHost),
            engineRow(page)
                .getByRole('link', { name: /^(Open|Continue setup on) engine/ })
                .click(),
        ]);
        await opened.waitForLoadState('load');
        expect(new URL(opened.url()).hostname).toBe(engineHost);
        expect(await response.headerValue('content-security-policy')).toContain("require-trusted-types-for 'script'");
        // The conformance build's own development CA, created in its data directory: nothing we host issued it.
        const certificate = await pageCertificate(opened);
        expect(certificate.subjectAltName).toContain(engineHost);
        test.info().annotations.push({ type: 'engine certificate issuer', description: certificate.issuer });
        await opened.close();
    });

    const enginePage = await context.newPage();
    await addPasskeyAuthenticator(enginePage);
    await test.step('the setup link from dev:link makes this browser the owner with a passkey', async () => {
        await enginePage.goto(setupLink ?? '');
        await expect(enginePage.getByRole('heading', { name: 'Set up your engine' })).toBeVisible();
        await enginePage.locator('button[data-action="create"]').click();
        await expect(enginePage.getByRole('heading', { name: 'You are the owner' })).toBeVisible();
    });

    await test.step('the engine opens on our signed UI, which its loader installed from the stack', async () => {
        await enginePage.goto(`https://${engineHost}/`);
        await enginePage.waitForLoadState('load');
        const heading = await enginePage.getByRole('heading', { level: 1 }).first().textContent();
        test.info().annotations.push({ type: 'engine page', description: `${enginePage.url()}: ${heading ?? ''}` });
        await expect(enginePage.locator('html[data-ui-version]')).toBeAttached();
    });

    expect(violations).toEqual([]);
});
