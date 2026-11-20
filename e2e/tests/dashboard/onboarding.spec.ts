import type { BrowserContext, Page, TestInfo } from '@playwright/test';

import type { OneOffContainer } from '../../src/compose.ts';
import type { SetupLink } from '../../src/dashboard-outputs.ts';
import { devInstallLinkCode, distinctInOrder, parseSetupLink, terminalIdentity } from '../../src/dashboard-outputs.ts';
import {
    BILLING_OFF,
    ENGINE_CLI,
    addPasskeyAuthenticator,
    expect,
    isEngineUrl,
    test,
    uniqueEmail,
} from '../../src/dashboard.ts';
import { DASHBOARD_ORIGIN, DASHBOARD_TIMING } from '../../src/stack.ts';

// X-07: Journey 1 of docs/design/onboarding.md as a person walks it, on a fresh engine that has no owner and no dev
// login. The engine's commands run inside its container as an operator types them; only their stdout is read for the
// setup link, never the log stream, which must not carry it.

const POLICY_BINDING = '__ptbkE2eOnboardingPolicy';
const LINK_STATE_BINDING = '__ptbkE2eLinkState';
const HEARTBEAT_MS = DASHBOARD_TIMING.heartbeatIntervalS * 1000;
// Heartbeats every 15 s; the page polls every 3 s.
const NEXT_HEARTBEAT_MS = HEARTBEAT_MS * 2 + 10_000;
// Each relay reports a ready tunnel within its 5-second window (R-07), once the tunnel is up.
const REACHABLE_WITHIN_MS = 60_000;
// The engine needs a relay connection and a certificate before it prints a setup link.
const SETUP_LINK_WITHIN_MS = 120_000;

/**
 * Every CSP and Trusted Types refusal, and every uncaught error, on any page of the context: the dashboard, the setup
 * page, the engine UI.
 */
async function watchPolicy(context: BrowserContext): Promise<readonly string[]> {
    const violations: string[] = [];
    await context.exposeBinding(POLICY_BINDING, ({ page }, violation: string) => {
        violations.push(`${page.url()}: ${violation}`);
    });
    await context.addInitScript((binding) => {
        document.addEventListener('securitypolicyviolation', (event) => {
            const report = (window as unknown as Record<string, (violation: string) => void>)[binding];
            report?.(`${event.effectiveDirective} ${event.blockedURI}`);
        });
    }, POLICY_BINDING);
    context.on('console', (message) => {
        if (/Content Security Policy|Trusted ?Type|Trusted(HTML|Script)|Refused to /i.test(message.text())) {
            violations.push(`${message.page()?.url() ?? 'no page'}: ${message.text()}`);
        }
    });
    context.on('weberror', (error) => {
        violations.push(`${error.page()?.url() ?? 'no page'}: ${error.error().message}`);
    });
    return violations;
}

/**
 * Each `data-link-state` the link page renders, as it renders it. A short state such as `linked` (until the engine's
 * first answer arrives) can come and go between two of the test's own polls.
 */
async function recordLinkStates(context: BrowserContext): Promise<readonly string[]> {
    const states: string[] = [];
    await context.exposeBinding(LINK_STATE_BINDING, (_source, state: string) => {
        states.push(state);
    });
    await context.addInitScript((binding) => {
        let last: string | null = null;
        const report = (): void => {
            const state = document.querySelector('[data-link-state]')?.getAttribute('data-link-state') ?? null;
            if (state === null || state === last) return;
            last = state;
            (window as unknown as Record<string, (state: string) => void>)[binding]?.(state);
        };
        new MutationObserver(report).observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['data-link-state'],
        });
    }, LINK_STATE_BINDING);
    return states;
}

/** Until the engine answers on its operator socket: `connect` hands the registration to the running engine there. */
async function waitUntilRunning(engine: OneOffContainer): Promise<void> {
    await expect
        .poll(async () => (await engine.exec([...ENGINE_CLI, 'status', '--json'])).exitCode, {
            timeout: 60_000,
            intervals: [500, 1_000],
        })
        .toBe(0);
}

async function ownerSetUp(engine: OneOffContainer): Promise<boolean> {
    const { exitCode, stdout } = await engine.exec([...ENGINE_CLI, 'status', '--json']);
    expect(exitCode).toBe(0);
    return (JSON.parse(stdout) as { ownerSetUp?: unknown }).ownerSetUp === true;
}

/**
 * `setup-link --json --no-wait` until it answers with a link. The command's own wait is the same one-second poll, but
 * one exec would outlast the Docker API client's request timeout while the certificate is issued.
 */
async function takeSetupLink(engine: OneOffContainer): Promise<string> {
    let stdout = '';
    await expect
        .poll(
            async () => {
                const result = await engine.exec([...ENGINE_CLI, 'setup-link', '--json', '--no-wait']);
                stdout = result.stdout;
                return result.exitCode;
            },
            { timeout: SETUP_LINK_WITHIN_MS, intervals: [1_000] },
        )
        .toBe(0);
    return stdout;
}

function meStatus(page: Page): Promise<number> {
    return page.evaluate(async () => (await fetch('/api/v1/me', { credentials: 'same-origin' })).status);
}

/** The onboarding targets as measured, in the report rather than as limits: the stack's speed is not the product's. */
async function recordTimings(testInfo: TestInfo, timings: Readonly<Record<string, number>>): Promise<void> {
    const lines = Object.entries(timings).map(([segment, ms]) => `${segment}: ${(ms / 1000).toFixed(1)} s`);
    for (const line of lines) testInfo.annotations.push({ type: 'timing', description: line });
    await testInfo.attach('onboarding-timings.json', {
        body: JSON.stringify(timings, null, 2),
        contentType: 'application/json',
    });
    process.stdout.write(`onboarding timings:\n${lines.map((line) => `  ${line}\n`).join('')}`);
}

test('Journey 1: sign up, start the trial, link a fresh engine, become its owner and open it', async ({
    page,
    dashboard,
    mockEngines,
    requestLog,
}, testInfo) => {
    test.setTimeout(420_000);
    const context = page.context();
    const violations = await watchPolicy(context);
    const linkStates = await recordLinkStates(context);
    const email = uniqueEmail('onboarding');
    const progress = page.locator('section[data-link-state]');
    const row = (step: string) => progress.locator(`[data-step="${step}"]`);

    const landedAt = Date.now();
    await dashboard.signUp(email);
    const accountAt = Date.now();

    const planStep = BILLING_OFF
        ? 'with billing off there is no plan step: the code is issued on arrival'
        : 'the plan step comes first, and the trial returns to the link page';
    await test.step(planStep, async () => {
        await page.goto(`${DASHBOARD_ORIGIN}/engines/new`);
        if (BILLING_OFF) {
            await expect(page).toHaveURL(/\/engines\/new\?link=[a-z2-7]{26}$/);
            await expect(page.getByRole('heading', { name: 'Choose a plan to link your project' })).toHaveCount(0);
            return;
        }
        await expect(page.getByRole('heading', { name: 'Choose a plan to link your project' })).toBeVisible();
        await page.getByRole('button', { name: 'Start your 14-day trial of Standard' }).click();
        await expect(page.getByText('Thank you, your trial has started.')).toBeVisible();
        // Thanked once: the address no longer carries `checkout`, so a reload does not thank again.
        await expect(page).toHaveURL(/\/engines\/new\?link=[a-z2-7]{26}$/);
    });

    const installer = page.getByRole('tab', { name: 'Linux server with Docker' });
    await expect(installer).toHaveAttribute('aria-selected', 'true');
    const linkCode = devInstallLinkCode((await page.getByRole('tabpanel').locator('code').textContent()) ?? '');
    // The link URL names the dashboard, so the engine needs nothing else to find it.
    const linkUrl = (await page.getByText(/^https:\/\/\S+\/link#[a-z2-7]{26}$/).textContent()) ?? '';
    expect(linkUrl).toBe(`${DASHBOARD_ORIGIN}/link#${linkCode}`);
    const commandAt = Date.now();
    await expect(progress).toHaveAttribute('data-link-state', 'waiting');
    await expect(row('linked')).toHaveAttribute('data-step-state', 'current');

    const pastedAt = Date.now();
    // Paired before setup, as a Reborn engine installed from the dashboard is: setup finishes in the browser.
    const engine = await mockEngines.startUnlinked({ setup: 'pending' });
    await waitUntilRunning(engine);
    expect(await ownerSetUp(engine)).toBe(false);
    const connect = await engine.exec([...ENGINE_CLI, 'connect', '--link', linkUrl]);
    expect(connect.exitCode, connect.stderr).toBe(0);
    expect(connect.stdout).toContain(`Linking with the Promptbook dashboard at ${DASHBOARD_ORIGIN}`);
    expect(connect.stdout).toContain('✓ Linked to your Promptbook account');
    expect(connect.stdout).not.toContain(linkCode);
    const identity = terminalIdentity(connect.stdout);

    await test.step('the checklist follows the engine: linked, online, reachable, waiting for the owner', async () => {
        await expect(row('linked')).toHaveAttribute('data-step-state', 'done');
        // The comparison the operator is asked to make: the page's fingerprint is the terminal's.
        await expect(row('linked').getByText(identity.fingerprint, { exact: true })).toBeVisible();
        await expect(row('linked').getByText(identity.hostname, { exact: true })).toBeVisible();
        await expect(row('online')).toHaveAttribute('data-step-state', 'done', { timeout: NEXT_HEARTBEAT_MS });
        await expect(row('online').locator('p')).toHaveText(/^Project online, version \S+\.$/);
        await expect(row('reachable')).toHaveAttribute('data-step-state', 'done', { timeout: REACHABLE_WITHIN_MS });
        await expect(row('reachable')).toContainText('Reachable through 2 relays');
        await expect(progress).toHaveAttribute('data-link-state', 'owner-pending');
        await expect(row('owner')).toHaveAttribute('data-step-state', 'current');
        await expect(row('owner')).toContainText('browser window that opened on the project');
    });

    const setupLink = parseSetupLink(await takeSetupLink(engine));
    const setupLinkAt = Date.now();
    expect(new URL(setupLink.url).hostname).toBe(identity.hostname);

    const enginePage = await context.newPage();
    // The engine is another relying party, in another tab.
    await addPasskeyAuthenticator(enginePage);
    await test.step('the setup link makes the person the owner with a passkey', async () => {
        await enginePage.goto(setupLink.url);
        await expect(enginePage.getByRole('heading', { name: 'Set up your project' })).toBeVisible();
        expect(new URL(enginePage.url()).hash).toBe('');
        await expect(enginePage.locator('section[data-state="valid"]')).toContainText(identity.fingerprint);
        await enginePage.locator('button[data-action="create"]').click();
        await expect(enginePage.locator('section[data-state="done"]')).toBeVisible();
        await expect(enginePage.getByRole('heading', { name: 'You are the owner' })).toBeVisible();
    });
    const signedInAt = Date.now();
    expect(await ownerSetUp(engine)).toBe(true);

    await page.bringToFront();
    await expect(progress).toHaveAttribute('data-link-state', 'ready', { timeout: NEXT_HEARTBEAT_MS });
    const readyAt = Date.now();
    await expect(row('owner')).toHaveAttribute('data-step-state', 'done');
    expect(distinctInOrder(linkStates)).toEqual(['waiting', 'linked', 'owner-pending', 'ready']);

    await test.step('"Continue setup" opens the engine on its setup, signed in, with no passkey prompt', async () => {
        const ready = page.locator('[data-link-ready]');
        await expect(ready.getByRole('link', { name: 'Back to projects' })).toBeVisible();
        // The engine reports its setup unfinished, so the ready panel continues it rather than opening the engine (D-36).
        const open = ready.getByRole('link', { name: /^Continue setup on project/ });
        await expect(open).toHaveAttribute('href', `https://${identity.hostname}/`);
        const [appPage] = await Promise.all([context.waitForEvent('page'), open.click()]);
        await appPage.waitForLoadState('load');
        expect(new URL(appPage.url()).hostname).toBe(identity.hostname);
        // The cross-site link leaves the SameSite=Strict cookie behind; the sign-in page finds the session itself. The
        // engine has no project yet, so the UI goes on to its setup.
        await expect(appPage).toHaveURL(`https://${identity.hostname}/onboarding`);
        await expect(appPage.getByRole('heading', { level: 1, name: 'Your project' })).toBeVisible();
        expect(await meStatus(appPage)).toBe(200);
        await appPage.close();
    });

    await test.step('the used setup link is dead', async () => {
        // A new tab: in the setup tab, only the fragment would change, and the page would not load again.
        const reused = await context.newPage();
        await reused.goto(setupLink.url);
        await expect(reused.getByRole('heading', { name: 'This engine already has an owner' })).toBeVisible();
        await reused.close();
        await enginePage.close();
    });

    const onlineEmails = async () =>
        (await dashboard.emails(email)).filter((sent) => sent.template === 'engine-online');
    await test.step('the outbox holds exactly one "online" email', async () => {
        await expect.poll(async () => (await onlineEmails()).length).toBeGreaterThan(0);
        const [online, ...more] = await onlineEmails();
        expect(more).toEqual([]);
        // Unnamed when its first heartbeat arrives, so the email names it by its short ID and gives the address below.
        expect(online?.subject).toBe(`Your project ${identity.hostname.slice(0, 8)}… is online`);
        expect(online?.text).toContain(identity.hostname);
        expect(online?.text).toContain("open the setup link in the project's terminal");
    });

    const engineRow = async () => (await dashboard.reloadEngineRows()).filter({ hasText: identity.hostname });
    // Online with an owner, but its setup is not finished yet (D-36).
    await expect((await engineRow()).getByText('Setup not finished', { exact: true })).toBeVisible();

    let resetLink: SetupLink | undefined;
    await test.step('owner --reset: the dashboard shows "Owner not set up" again', async () => {
        const reset = await engine.exec([...ENGINE_CLI, 'owner', '--reset', '--yes', '--json']);
        expect(reset.exitCode, reset.stderr).toBe(0);
        resetLink = parseSetupLink(reset.stdout);
        expect(resetLink.secret).not.toBe(setupLink.secret);
        expect(await ownerSetUp(engine)).toBe(false);
        await expect
            .poll(async () => (await engineRow()).getByText('Owner not set up', { exact: true }).count(), {
                timeout: NEXT_HEARTBEAT_MS,
                intervals: [2_000],
            })
            .toBe(1);
    });

    // Later heartbeats send nothing more: "online" is once per engine.
    expect(await onlineEmails()).toHaveLength(1);
    expect((await dashboard.emails(email)).filter((sent) => sent.template === 'engine-back-online')).toEqual([]);

    await test.step("the engine's log stream carries no link code, link URL or setup secret", async () => {
        const logs = await engine.logs();
        expect(logs).toMatch(/"event":"setup-link\.issued"/);
        expect(logs).toMatch(/"event":"owner\.passkey-registered"/);
        expect(logs).toMatch(/"event":"owner\.reset"/);
        for (const secret of [linkCode, linkUrl, setupLink.secret, resetLink?.secret ?? '']) {
            expect(secret).not.toBe('');
            expect(logs).not.toContain(secret);
        }
    });

    expect(requestLog.filter(isEngineUrl), 'the dashboard page never asks an engine').toEqual([]);
    expect(violations).toEqual([]);
    await recordTimings(testInfo, {
        'landing → account with passkey': accountAt - landedAt,
        'account → install command': commandAt - accountAt,
        'command → setup link': setupLinkAt - pastedAt,
        'setup link → signed in': signedInAt - setupLinkAt,
        'landing → ready': readyAt - landedAt,
    });
});

test('an expired link code: the page says so and the engine refuses it', async ({ page, dashboard, mockEngines }) => {
    test.setTimeout(180_000);
    await dashboard.signUp(uniqueEmail('onboarding-expired'));
    await dashboard.subscribe();
    const { linkCode } = await dashboard.createLinkCode();

    const progress = page.locator('section[data-link-state]');
    await expect(progress).toHaveAttribute('data-link-state', 'expired', {
        timeout: (DASHBOARD_TIMING.linkCodeTtlS + 15) * 1000,
    });
    await expect(progress.getByRole('button', { name: 'Create a new link code' })).toBeVisible();
    await expect(page.getByRole('tabpanel')).toHaveCount(0);

    const engine = await mockEngines.startUnlinked();
    await waitUntilRunning(engine);
    const connect = await engine.exec([...ENGINE_CLI, 'connect', '--link', linkCode]);
    expect(connect.exitCode).toBe(3);
    expect(connect.stdout).toContain('✗ The link code was not accepted.');
    expect(await engine.logs()).not.toContain(linkCode);
    await expect(await dashboard.reloadEngineRows()).toHaveCount(0);
});
