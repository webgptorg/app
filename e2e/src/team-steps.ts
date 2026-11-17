// The teams flow's steps (X-09), shared by the specs that invite people to an engine and let them in. Each person has
// their own browser context, authenticator and client address, as they would their own laptop.
import { randomInt } from 'node:crypto';

import type { Browser, Page } from '@playwright/test';
import { devices } from '@playwright/test';

import type { OneOffContainer } from './compose.ts';
import type { DashboardSteps } from './dashboard.ts';
import { ENGINE_CLI, addPasskeyAuthenticator, expect, sharePasskeys, uniqueEmail } from './dashboard.ts';
import type { OutboxEmail } from './dashboard-outputs.ts';
import { devInstallLinkCode, parseSetupLink, terminalIdentity } from './dashboard-outputs.ts';
import { DASHBOARD_ORIGIN, DASHBOARD_TIMING, MOCK_ENGINE_CONTROL } from './stack.ts';

export const HEARTBEAT_MS = DASHBOARD_TIMING.heartbeatIntervalS * 1000;
// The engine picks a revocation up in the reply to its next heartbeat; a beat in flight may have missed it.
export const ONE_HEARTBEAT_MS = HEARTBEAT_MS * 2;
// The ack rides on the beat after that one, and the team page refetches on load.
export const ACKED_WITHIN_MS = HEARTBEAT_MS * 3 + 10_000;
const REACHABLE_WITHIN_MS = 90_000;
const SETUP_LINK_WITHIN_MS = 120_000;

export interface TeamEngine {
    readonly container: OneOffContainer;
    readonly origin: string;
    /** The org admin who linked it, also the engine's owner. */
    readonly ownerEmail: string;
    /** The admin's tab on the engine, signed in as its owner. */
    readonly owner: Page;
    /**
     * Makes every session's passkey assertion stale, so the next step-up route asks again. A sign-in counts as fresh for
     * 5 minutes, which these flows never outlast; this is how they reach step-up, as an owner signed in yesterday would.
     */
    expireStepUp(): Promise<void>;
}

/**
 * `/api/v1/me` from the tab, or `null` while it cannot say: the tab is between pages (an ended session sends the engine
 * UI to sign-in, which destroys the page mid-call) or, given `engineOrigin`, on another origin. A poll then asks again.
 */
export async function meStatus(page: Page, engineOrigin?: string): Promise<number | null> {
    try {
        return await page.evaluate(async (expected) => {
            if (expected !== undefined && location.origin !== expected) return null;
            return (await fetch('/api/v1/me', { credentials: 'same-origin' })).status;
        }, engineOrigin);
    } catch (error) {
        if (error instanceof Error && error.message.includes('Execution context was destroyed')) return null;
        throw error;
    }
}

/**
 * Runs `act`, then answers the engine's step-up if it asks: the passkey in the gateway's popup, after which the app
 * runs the same action again by itself. Ends when `done` shows, and says whether the engine asked.
 */
export async function withStepUp(
    page: Page,
    act: () => Promise<void>,
    done: () => Promise<void>,
): Promise<'asked' | 'not-asked'> {
    await act();
    const stepUp = page.getByRole('button', { name: 'Continue with passkey' });
    // The loser of the race fails later on its own timeout; only the winner counts.
    const finished = done().then(() => 'done' as const);
    const asked = stepUp.waitFor().then(() => 'asked' as const);
    finished.catch(() => undefined);
    asked.catch(() => undefined);
    if ((await Promise.race([finished, asked])) === 'done') return 'not-asked';
    const opened = page.waitForEvent('popup');
    await stepUp.click();
    const popup = await opened;
    await sharePasskeys(page, popup);
    // The page starts the prompt by itself; if that ran before the popup had the passkey, it offers the button.
    const closed = popup.waitForEvent('close');
    const confirm = popup.locator('section[data-state="ready"] button[data-action="confirm"]');
    const ready = confirm.waitFor().then(() => 'ready' as const);
    ready.catch(() => undefined);
    if ((await Promise.race([closed.then(() => 'closed' as const), ready])) === 'ready') await confirm.click();
    await closed;
    await done();
    return 'asked';
}

/**
 * Gives the page's dashboard calls a client address of their own. The dashboard limits anonymous ceremonies per
 * address, and every person of every run would otherwise share the playwright container's.
 */
export async function ownClientAddress(page: Page): Promise<void> {
    const address = `198.18.${String(randomInt(256))}.${String(randomInt(1, 255))}`;
    await page.route(`${DASHBOARD_ORIGIN}/api/**`, (route) =>
        route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': address } }),
    );
}

export interface Person {
    readonly page: Page;
    /** How many passkeys this person's authenticator holds for `rpId`. */
    passkeys(rpId: string): Promise<number>;
}

/** Someone on their own laptop: a new browser context, an authenticator with no passkey yet and their own address. */
export async function newPerson(browser: Browser): Promise<Person> {
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();
    const authenticatorId = await addPasskeyAuthenticator(page);
    await ownClientAddress(page);
    const cdp = await context.newCDPSession(page);
    return {
        page,
        async passkeys(rpId) {
            const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
            return credentials.filter((credential) => credential.rpId === rpId).length;
        },
    };
}

/** The org admin's account, a team, its engine linked and reachable, with the admin as the engine's owner. */
export async function linkTeamEngine(
    page: Page,
    dashboard: DashboardSteps,
    startUnlinked: () => Promise<OneOffContainer>,
    team: string,
): Promise<TeamEngine> {
    const ownerEmail = uniqueEmail('teams-admin');
    await dashboard.signUp(ownerEmail);
    await dashboard.subscribe();

    await page.goto(`${DASHBOARD_ORIGIN}/engines`);
    await page.getByRole('button', { name: 'New engine' }).click();
    await page.getByLabel('Engine name').fill(team);
    await page.getByRole('button', { name: 'Create and link an engine' }).click();
    await expect(page).toHaveURL(/\/engines\/new\?.*link=[a-z2-7]{26}/);
    const linkCode = devInstallLinkCode((await page.getByRole('tabpanel').locator('code').textContent()) ?? '');

    const container = await startUnlinked();
    await expect
        .poll(async () => (await container.exec([...ENGINE_CLI, 'status', '--json'])).exitCode, {
            timeout: 60_000,
            intervals: [500, 1_000],
        })
        .toBe(0);
    const connect = await container.exec([...ENGINE_CLI, 'connect', '--link', linkCode]);
    expect(connect.exitCode, connect.stderr).toBe(0);
    const { hostname } = terminalIdentity(connect.stdout);

    await expect(page.locator('section[data-link-state]')).toHaveAttribute('data-link-state', 'owner-pending', {
        timeout: REACHABLE_WITHIN_MS,
    });
    let setup = '';
    await expect
        .poll(
            async () => {
                const result = await container.exec([...ENGINE_CLI, 'setup-link', '--json', '--no-wait']);
                setup = result.stdout;
                return result.exitCode;
            },
            { timeout: SETUP_LINK_WITHIN_MS, intervals: [1_000] },
        )
        .toBe(0);

    const ownerPage = await page.context().newPage();
    await addPasskeyAuthenticator(ownerPage);
    await ownerPage.goto(parseSetupLink(setup).url);
    await ownerPage.locator('button[data-action="create"]').click();
    await expect(ownerPage.getByRole('heading', { name: 'You are the owner' })).toBeVisible();
    return {
        container,
        origin: `https://${hostname}`,
        ownerEmail,
        owner: ownerPage,
        async expireStepUp() {
            // The control listener is the engine's own, on its loopback; nothing outside the container is involved.
            const expire = await container.exec([
                'node',
                '-e',
                `fetch('http://127.0.0.1:${String(MOCK_ENGINE_CONTROL.port)}/__mock/step-up/expire', { method: 'POST' })` +
                    '.then((response) => process.exit(response.status === 204 ? 0 : 1))',
            ]);
            expect(expire.exitCode, expire.stderr).toBe(0);
        },
    };
}

/** The admin opens the team's page and invites `email` with "Invite to this engine", as an org member. */
export async function inviteToEngine(page: Page, team: string, email: string): Promise<void> {
    await page.goto(`${DASHBOARD_ORIGIN}/engines`);
    await page.getByRole('link', { name: team, exact: true }).click();
    await expect(page.getByRole('heading', { name: team, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Invite to this engine' }).click();
    const dialog = page.getByRole('dialog', { name: `Invite people to ${team}` });
    await dialog.getByLabel('Email addresses').fill(email);
    await expect(dialog.getByRole('checkbox', { name: team })).toBeChecked();
    await dialog.getByRole('button', { name: 'Send invitations' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: email }).getByText('Invited')).toBeVisible();
}

/** After joining, the dashboard sends the person on to the engine's join page by itself. */
export async function expectContinuedToEngine(person: Page, engineOrigin: string): Promise<void> {
    await expect(
        person.getByText('Next, confirm a passkey for the engine itself: it has its own secure address.'),
    ).toBeVisible();
    await person.waitForURL((url) => url.origin === engineOrigin && url.pathname === '/auth/join');
    expect(new URL(person.url()).hash).toBe('');
}

/** On the engine's join page: registers the engine passkey and reads the code the waiting page shows. */
export async function waitWithCode(person: Page): Promise<string> {
    await person.locator('section[data-state="valid"] button[data-action="create"]').click();
    await expect(person.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
    const code = (await person.locator('section[data-state="waiting"] [data-join-code]').first().textContent()) ?? '';
    expect(code).toMatch(/^\d{3} \d{3}$/);
    return code;
}

/** The newest email of `template` to `to`, once the dev outbox holds one. */
export async function emailed(
    dashboard: DashboardSteps,
    to: string,
    template: string,
    timeout = 10_000,
): Promise<OutboxEmail> {
    let found: OutboxEmail | undefined;
    await expect
        .poll(
            async () => {
                found = (await dashboard.emails(to)).findLast((email) => email.template === template);
                return found !== undefined;
            },
            { timeout, intervals: [1_000] },
        )
        .toBe(true);
    if (found === undefined) throw new Error(`no ${template} email`);
    return found;
}

/** The person's waiting page signs them in once approved and opens the engine. */
export async function expectSignedInToEngine(person: Page, engineOrigin: string): Promise<void> {
    await person.waitForURL((url) => url.origin === engineOrigin && !url.pathname.startsWith('/auth/'));
    await expect(person.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await meStatus(person)).toBe(200);
}
