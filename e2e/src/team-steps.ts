// The teams flow's steps (X-09), shared by the specs that invite people to an engine and let them in. Each person has
// their own browser context, authenticator and client address, as they would their own laptop.
import { randomInt } from 'node:crypto';

import type { Browser, Frame, Page, Route } from '@playwright/test';
import { devices } from '@playwright/test';

import type { OneOffContainer } from './compose.ts';
import type { DashboardSteps } from './dashboard.ts';
import { ENGINE_CLI, addPasskeyAuthenticator, expect, sharePasskeys, uniqueEmail } from './dashboard.ts';
import type { OutboxEmail } from './dashboard-outputs.ts';
import { devInstallLinkCode, terminalIdentity } from './dashboard-outputs.ts';
import { DASHBOARD_ORIGIN, DASHBOARD_TIMING, MOCK_ENGINE_CONTROL } from './stack.ts';

export const HEARTBEAT_MS = DASHBOARD_TIMING.heartbeatIntervalS * 1000;
// The engine picks a revocation up in the reply to its next heartbeat; a beat in flight may have missed it.
export const ONE_HEARTBEAT_MS = HEARTBEAT_MS * 2;
// The ack rides on the beat after that one, and the team page refetches on load.
export const ACKED_WITHIN_MS = HEARTBEAT_MS * 3 + 10_000;
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
    // In place: the page itself never goes to the step-up page, so nothing the member entered is lost.
    const left: string[] = [];
    const onNavigation = (frame: Frame) => {
        if (frame === page.mainFrame() && new URL(frame.url()).pathname.startsWith('/auth/')) left.push(frame.url());
    };
    const context = page.context();
    const optionsUrl = new URL('/auth/step-up/options', page.url()).href;
    // A real platform authenticator is already available when a new tab starts WebAuthn. Give the popup its
    // virtual one before delivering the real engine's challenge, even if it asks before Playwright emits "popup".
    const preparePasskeys = async (route: Route) => {
        await sharePasskeys(page, route.request().frame().page());
        await route.continue();
    };
    await context.route(optionsUrl, preparePasskeys, { times: 1 });
    page.on('framenavigated', onNavigation);
    try {
        const opened = page.waitForEvent('popup');
        await stepUp.click();
        const popup = await opened;
        if (!popup.isClosed()) await popup.waitForEvent('close');
        await done();
    } finally {
        page.off('framenavigated', onNavigation);
        await context.unroute(optionsUrl, preparePasskeys);
    }
    expect(left).toEqual([]);
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

    // The pairing tab follows the owner handoff to the engine. Keep the dashboard tab for later invitations.
    const ownerPage = await page.context().newPage();
    await sharePasskeys(page, ownerPage);
    await ownerPage.goto(`${DASHBOARD_ORIGIN}/engines`);
    await ownerPage.getByRole('button', { name: 'New project' }).click();
    await ownerPage.getByLabel('Project name').fill(team);
    await ownerPage.getByRole('button', { name: 'Create and link a project' }).click();
    await expect(ownerPage).toHaveURL(/\/engines\/new\?.*link=[a-z2-7]{26}/);
    const linkCode = devInstallLinkCode((await ownerPage.getByRole('tabpanel').locator('code').textContent()) ?? '');

    const container = await startUnlinked();
    await expect
        .poll(async () => (await container.exec([...ENGINE_CLI, 'status', '--json'])).exitCode, {
            timeout: 60_000,
            intervals: [500, 1_000],
        })
        .toBe(0);
    const connect = await container.exec([...ENGINE_CLI, 'connect', '--link', linkCode]);
    expect(connect.exitCode, connect.stderr).toBe(0);
    const { hostname, fingerprint } = terminalIdentity(connect.stdout);
    const origin = `https://${hostname}`;
    await ownerPage.waitForURL((url) => url.origin === origin && url.pathname === '/setup', {
        timeout: SETUP_LINK_WITHIN_MS,
    });
    await expect(ownerPage.locator('section[data-state="valid"]')).toContainText(fingerprint);
    await ownerPage.locator('button[data-action="create"]').click();
    await expect(ownerPage.getByRole('heading', { name: 'You are the owner' })).toBeVisible();
    return {
        container,
        origin,
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

/** "Invite people" on the People page, to the organization alone. */
export async function inviteToOrganization(page: Page, email: string): Promise<void> {
    await page.goto(`${DASHBOARD_ORIGIN}/people`);
    await page.getByRole('button', { name: 'Invite people' }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite people' });
    await dialog.getByLabel('Email addresses').fill(email);
    await dialog.getByRole('button', { name: 'Send invitations' }).click();
    await expect(page.getByText('Invitations sent: 1')).toBeVisible();
}

/** The admin opens the team's page and invites `email` with "Invite to this project", as an org member. */
export async function inviteToEngine(page: Page, team: string, email: string): Promise<void> {
    await page.goto(`${DASHBOARD_ORIGIN}/engines`);
    await page.getByRole('link', { name: team, exact: true }).click();
    await expect(page.getByRole('heading', { name: team, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Invite to this project' }).click();
    const dialog = page.getByRole('dialog', { name: `Invite people to ${team}` });
    await dialog.getByLabel('Email addresses').fill(email);
    await expect(dialog.getByRole('checkbox', { name: team })).toBeChecked();
    await dialog.getByRole('button', { name: 'Send invitations' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: email }).getByText('Invited')).toBeVisible();
}

/** After joining, the dashboard sends the person on to the engine's join page by itself. */
export async function expectContinuedToEngine(person: Page, engineOrigin: string): Promise<void> {
    await expect(
        person.getByText('Next, confirm a passkey for the project itself: it has its own secure address.'),
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

/** The statuses the engine answered to approvals of access requests from this page, in order. */
export function approvalAnswers(page: Page): number[] {
    const statuses: number[] = [];
    page.on('response', (response) => {
        if (/\/api\/v1\/access-requests\/[^/]+\/approve$/.test(new URL(response.url()).pathname)) {
            statuses.push(response.status());
        }
    });
    return statuses;
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
