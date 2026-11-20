import { LinkCode, REGISTER_PATH } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { orgIdSchema } from '../../src/domain/ids';
import { HANDOFF_STATE_TTL_MS, PENDING_LINK_TTL_MS } from '../../src/domain/licensing/website-access';
import type { LicenseGrant } from '../../src/domain/licensing/license-contract';
import type { LicenseView, LinkCodeView, SessionView, WebsitePendingView } from '../../src/shared/api/routes';
import { createAuthHarness, ORIGIN, type AuthHarness, type TestBrowser } from '../../src/testing/auth-harness';
import { linkToken, problemCode, registerWith, signIn, signUp, uniqueEmail } from '../../src/testing/auth-flows';
import { FAKE_HANDOFF_URL } from '../../src/testing/fake-website';
import { createMemoryAuthStore, type MemoryAuthState } from '../../src/testing/memory-auth-store';
import { createTestEngine } from '../../src/testing/test-engine';

const STATE_COOKIE = '__Host-ptbk_website_state';
const LINK_COOKIE = '__Host-ptbk_website_link';
const DAY = 86_400_000;

function websiteHarness(
    licenseEnforcement?: 'advisory' | 'enforce',
): AuthHarness & { readonly state: MemoryAuthState } {
    const store = createMemoryAuthStore();
    return Object.assign(
        createAuthHarness({
            store,
            billing: 'website',
            ...(licenseEnforcement === undefined ? {} : { licenseEnforcement }),
        }),
        { state: store.state },
    );
}

function subject(): string {
    return crypto.randomUUID();
}

function grant(
    capabilities: Partial<LicenseGrant['capabilities']> = {},
    validUntil: string | null = null,
): LicenseGrant {
    return {
        id: crypto.randomUUID(),
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil,
        capabilities: {
            engineProjects: 1,
            specialists: 10,
            controllingUsers: 5,
            harnessInstances: null,
            browserProfiles: 5,
            remoteControl: true,
            ...capabilities,
        },
    };
}

/** The browser's round trip through the website: start here, the member page there, back with a ticket. */
async function handoff(
    harness: AuthHarness,
    browser: TestBrowser,
    identity: { readonly subject: string; readonly email: string },
) {
    const start = await browser.request('GET', '/api/website-access/start');
    const challenge = new URL(start.headers.get('location') ?? '').searchParams.get('challenge') ?? '';
    const code = harness.website.issueTicket(challenge, { ...identity, emailVerified: true });
    const back = await browser.request('GET', `/api/website-access/return?code=${code}`);
    return { start, challenge, code, back };
}

async function license(browser: TestBrowser): Promise<LicenseView> {
    const response = await browser.request('GET', '/api/license');
    expect(response.status).toBe(200);
    return response.body as LicenseView;
}

async function linkedOwner(harness: AuthHarness, grants?: readonly LicenseGrant[]) {
    const browser = harness.browser();
    const { email } = await signUp(harness, browser);
    const identity = { subject: subject(), email };
    if (grants !== undefined) harness.website.setGrants(identity.subject, grants);
    await handoff(harness, browser, identity);
    expect((await browser.request('POST', '/api/website-access/link')).status).toBe(200);
    return { browser, email, identity };
}

async function linkEngine(harness: AuthHarness, browser: TestBrowser): Promise<void> {
    const issued = await browser.request('POST', '/api/engines/link-codes');
    expect(issued.status).toBe(200);
    const engine = await createTestEngine();
    const request = await engine.register(LinkCode.parse((issued.body as LinkCodeView).linkCode));
    expect((await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request)).status).toBe(200);
}

describe('billing website: what is mounted', () => {
    it('mounts no Stripe route, and the licensing routes only in website mode', async () => {
        const harness = websiteHarness();
        const paths = harness.routes.map((route) => `${route.method} ${route.path}`);
        expect(paths.filter((path) => path.includes('billing') || path.includes('stripe'))).toEqual([]);
        expect(paths).toEqual(
            expect.arrayContaining([
                'GET /api/website-access/start',
                'GET /api/website-access/return',
                'GET /api/website-access/pending',
                'POST /api/website-access/link',
                'GET /api/license',
            ]),
        );
        const browser = harness.browser();
        await signUp(harness, browser);
        for (const [method, path] of [
            ['GET', '/api/billing'],
            ['POST', '/api/billing/checkout'],
            ['POST', '/api/billing/portal'],
            ['GET', '/api/admin/billing'],
        ] as const) {
            expect((await browser.request(method, path, method === 'POST' ? {} : undefined)).status).toBe(404);
        }
        expect((await harness.webhook('{}')).status).toBe(404);
        const session = (await browser.request('GET', '/api/session')).body as SessionView;
        expect(session).toMatchObject({ billingEnabled: false, licensing: true });

        const stripe = createAuthHarness({ store: createMemoryAuthStore() });
        expect(stripe.routes.some((route) => route.path.startsWith('/api/website-access'))).toBe(false);
        expect(stripe.routes.some((route) => route.path === '/api/license')).toBe(false);
    });

    it('never blocks linking an engine without any licence', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        await signUp(harness, browser);
        await linkEngine(harness, browser);
        await linkEngine(harness, browser);
        expect((await license(browser)).notice).toBe('unlinked');
        harness.website.outage = 503;
        await linkEngine(harness, browser);
    });
});

describe('billing website: the handoff', () => {
    it('starts with a fresh challenge in a short-lived __Host- Lax cookie and sends the browser to the website', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        const start = await browser.request('GET', '/api/website-access/start');
        expect(start.status).toBe(303);
        const location = new URL(start.headers.get('location') ?? '');
        expect(`${location.origin}${location.pathname}`).toBe(FAKE_HANDOFF_URL);
        const challenge = location.searchParams.get('challenge') ?? '';
        expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(start.setCookies).toEqual([
            `${STATE_COOKIE}=${challenge}; Max-Age=${String(HANDOFF_STATE_TTL_MS / 1000)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        ]);
        expect(start.headers.get('cache-control')).toBe('no-store');
        const again = await browser.request('GET', '/api/website-access/start');
        expect(new URL(again.headers.get('location') ?? '').searchParams.get('challenge')).not.toBe(challenge);
    });

    it('exchanges once, clears the state, and scrubs the ticket with an immediate no-referrer, no-store redirect', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        const { back } = await handoff(harness, browser, { subject: subject(), email: 'owner@example.test' });
        expect(back.status).toBe(303);
        expect(back.headers.get('location')).toBe(`${ORIGIN}/website-access`);
        expect(back.headers.get('referrer-policy')).toBe('no-referrer');
        expect(back.headers.get('cache-control')).toBe('no-store');
        expect(back.setCookies).toContain(`${STATE_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
        expect(back.setCookies.find((cookie) => cookie.startsWith(`${LINK_COOKIE}=`))).toMatch(
            new RegExp(`Max-Age=${String(PENDING_LINK_TTL_MS / 1000)}; Path=/; Secure; HttpOnly; SameSite=Strict$`),
        );
        expect(browser.cookies.has(STATE_COOKIE)).toBe(false);
        expect(harness.website.calls).toEqual(['POST /api/promptbook-billing/app/exchange']);
        const pending = await browser.request('GET', '/api/website-access/pending');
        expect(pending.body).toMatchObject({ email: 'owner@example.test', accountExists: false });
        expect(JSON.stringify(harness.logger.entries)).not.toContain('owner@example.test');
    });

    it('fails closed without the state cookie', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        const code = harness.website.issueTicket('c'.repeat(43), {
            subject: subject(),
            email: 'a@example.test',
            emailVerified: true,
        });
        const back = await browser.request('GET', `/api/website-access/return?code=${code}`);
        expect(back.headers.get('location')).toBe(`${ORIGIN}/website-access?error=expired`);
        expect(harness.website.calls).toEqual([]);
        expect(browser.cookies.has(LINK_COOKIE)).toBe(false);
    });

    it('fails closed on a replayed callback, even with the old state cookie put back', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        const start = await browser.request('GET', '/api/website-access/start');
        const challenge = new URL(start.headers.get('location') ?? '').searchParams.get('challenge') ?? '';
        const code = harness.website.issueTicket(challenge, {
            subject: subject(),
            email: 'a@example.test',
            emailVerified: true,
        });
        expect((await browser.request('GET', `/api/website-access/return?code=${code}`)).headers.get('location')).toBe(
            `${ORIGIN}/website-access`,
        );
        browser.cookies.set(STATE_COOKIE, challenge);
        const replay = await browser.request('GET', `/api/website-access/return?code=${code}`);
        expect(replay.headers.get('location')).toBe(`${ORIGIN}/website-access?error=expired`);
        expect(harness.website.calls).toHaveLength(1);
    });

    it('fails closed on an expired state', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        const start = await browser.request('GET', '/api/website-access/start');
        const challenge = new URL(start.headers.get('location') ?? '').searchParams.get('challenge') ?? '';
        harness.clock.advance(HANDOFF_STATE_TTL_MS);
        const code = harness.website.issueTicket(challenge, {
            subject: subject(),
            email: 'a@example.test',
            emailVerified: true,
        });
        const back = await browser.request('GET', `/api/website-access/return?code=${code}`);
        expect(back.headers.get('location')).toBe(`${ORIGIN}/website-access?error=expired`);
    });

    it.each([
        ['a forged ticket', () => 'f'.repeat(43)],
        [
            'a ticket for another browser’s challenge',
            (_challenge: string, harness: AuthHarness) =>
                harness.website.issueTicket('o'.repeat(43), {
                    subject: subject(),
                    email: 'a@example.test',
                    emailVerified: true,
                }),
        ],
        [
            'an expired ticket',
            (challenge: string, harness: AuthHarness) => {
                const code = harness.website.issueTicket(challenge, {
                    subject: subject(),
                    email: 'a@example.test',
                    emailVerified: true,
                });
                harness.clock.advance(60_001);
                return code;
            },
        ],
    ])('fails closed on %s, which the website refuses', async (_, ticket) => {
        const harness = websiteHarness();
        const browser = harness.browser();
        const start = await browser.request('GET', '/api/website-access/start');
        const challenge = new URL(start.headers.get('location') ?? '').searchParams.get('challenge') ?? '';
        const code = ticket(challenge, harness);
        const back = await browser.request('GET', `/api/website-access/return?code=${code}`);
        expect(back.headers.get('location')).toBe(`${ORIGIN}/website-access?error=failed`);
        expect(back.setCookies).toContain(`${STATE_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
    });

    it('fails closed on a ticket used once already, under a fresh handoff of the same browser', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        const { code } = await handoff(harness, browser, { subject: subject(), email: 'a@example.test' });
        await browser.request('GET', '/api/website-access/start');
        const replay = await browser.request('GET', `/api/website-access/return?code=${code}`);
        expect(replay.headers.get('location')).toBe(`${ORIGIN}/website-access?error=failed`);
    });

    it('refuses a malformed ticket before anything reads it', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        await browser.request('GET', '/api/website-access/start');
        expect((await browser.request('GET', '/api/website-access/return?code=short')).status).toBe(400);
        expect((await browser.request('GET', '/api/website-access/return')).status).toBe(400);
        expect(harness.website.calls).toEqual([]);
    });
});

describe('billing website: linking', () => {
    it('links the active organization of a signed-in owner with the same address, once, audited', async () => {
        const harness = websiteHarness();
        const { browser, identity } = await linkedOwner(harness, [grant()]);
        expect(browser.cookies.has(LINK_COOKIE)).toBe(false);
        const view = await license(browser);
        expect(view.link).toMatchObject({ linkedByEmail: identity.email });
        expect(view.state).toBe('current');
        expect((await browser.request('POST', '/api/website-access/link')).status).toBe(404);
        const orgId = orgIdSchema.parse(
            ((await browser.request('GET', '/api/session')).body as SessionView).activeOrg.id,
        );
        expect(await harness.websiteLicensing.subjectForOrg(orgId)).toBe(identity.subject);
    });

    it('fails closed for a signed-in account with another address, and links once the right one signs in', async () => {
        const harness = websiteHarness();
        const right = harness.browser();
        const { email } = await signUp(harness, right);
        const browser = harness.browser();
        await signUp(harness, browser);
        await handoff(harness, browser, { subject: subject(), email });
        const mismatch = await browser.request('POST', '/api/website-access/link');
        expect(mismatch.status).toBe(409);
        expect(problemCode(mismatch)).toBe('email-mismatch');
        expect((await license(browser)).link).toBeNull();
        expect((await browser.request('POST', '/api/auth/signout', {})).status).toBe(200);
        const signedIn = harness.browser({ authenticator: right.authenticator });
        signedIn.cookies.set(LINK_COOKIE, browser.cookies.get(LINK_COOKIE) ?? '');
        expect((await signIn(signedIn)).verify.status).toBe(200);
        expect((await signedIn.request('POST', '/api/website-access/link')).status).toBe(200);
    });

    it('refuses a website account already linked to another organization, and never rebinds a linked one', async () => {
        const harness = websiteHarness();
        const { identity } = await linkedOwner(harness);
        const other = harness.browser();
        await signUp(harness, other, identity.email.replace('@', '+other@'));
        await handoff(harness, other, { subject: identity.subject, email: identity.email.replace('@', '+other@') });
        const conflict = await other.request('POST', '/api/website-access/link');
        expect(conflict.status).toBe(409);
        expect(problemCode(conflict)).toBe('website-link-conflict');

        const owner = await linkedOwner(harness);
        await handoff(harness, owner.browser, { subject: subject(), email: owner.email });
        const rebind = await owner.browser.request('POST', '/api/website-access/link');
        expect(problemCode(rebind)).toBe('website-link-conflict');
    });

    it('lets no plain member link, and shows them no licence', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        const { email } = await signUp(harness, browser);
        const user = [...harness.state.users.values()].find((candidate) => candidate.email === email);
        const index = harness.state.memberships.findIndex((membership) => membership.userId === user?.id);
        const membership = harness.state.memberships[index];
        if (membership === undefined) throw new Error('no membership');
        harness.state.memberships[index] = { ...membership, role: 'member' };
        await handoff(harness, browser, { subject: subject(), email });
        const refused = await browser.request('POST', '/api/website-access/link');
        expect(refused.status).toBe(403);
        expect(problemCode(refused)).toBe('forbidden');
        expect((await browser.request('GET', '/api/license')).status).toBe(403);
        await expect(harness.websiteLicensing.subjectForOrg(orgIdSchema.parse(membership.orgId))).resolves.toBeNull();
    });

    it('asks a signed-out person with an account to sign in with their passkey, then links', async () => {
        const harness = websiteHarness();
        const owner = harness.browser();
        const { email } = await signUp(harness, owner);
        const browser = harness.browser({ authenticator: owner.authenticator });
        await handoff(harness, browser, { subject: subject(), email });
        expect((await browser.request('GET', '/api/website-access/pending')).body).toMatchObject({
            email,
            accountExists: true,
        });
        expect((await browser.request('POST', '/api/website-access/link')).status).toBe(401);
        expect((await signIn(browser)).verify.status).toBe(200);
        expect((await browser.request('POST', '/api/website-access/link')).status).toBe(200);
    });

    it('creates a new account only through the App’s own confirmation email and passkey, then links', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        const email = uniqueEmail('website');
        await handoff(harness, browser, { subject: subject(), email });
        const pending = (await browser.request('GET', '/api/website-access/pending')).body as WebsitePendingView;
        expect(pending).toMatchObject({ email, accountExists: false });
        expect(harness.state.users.size).toBe(0);
        expect((await browser.request('GET', '/api/session')).status).toBe(401);
        expect((await browser.request('POST', '/api/auth/signup/start', { email: pending.email })).status).toBe(202);
        const token = linkToken(harness, email);
        const { verify } = await registerWith(browser, '/api/auth/signup/options', '/api/auth/signup/verify', {
            token,
        });
        expect(verify.status).toBe(200);
        expect((await browser.request('POST', '/api/website-access/link')).status).toBe(200);
    });

    it('forgets a pending link after 30 minutes', async () => {
        const harness = websiteHarness();
        const browser = harness.browser();
        await handoff(harness, browser, { subject: subject(), email: 'late@example.test' });
        harness.clock.advance(PENDING_LINK_TTL_MS);
        const pending = await browser.request('GET', '/api/website-access/pending');
        expect(pending.status).toBe(404);
        expect(browser.cookies.has(LINK_COOKIE)).toBe(false);
    });
});

describe('billing website: licences', () => {
    it('reads several heterogeneous grants with unlimited capacities, leaving unknown usage unknown', async () => {
        const harness = websiteHarness();
        const { browser } = await linkedOwner(harness, [
            grant({ engineProjects: 1, controllingUsers: 2 }),
            grant({ engineProjects: null, controllingUsers: null, specialists: null }),
        ]);
        await linkEngine(harness, browser);
        await linkEngine(harness, browser);
        const view = await license(browser);
        expect(view.grants).toHaveLength(2);
        expect(view.grants[1]?.capabilities).toMatchObject({ engineProjects: null, specialists: null });
        expect(view.coverage).toEqual({
            engines: { used: 2, covered: 2, capacity: null },
            people: { used: 1, limit: null },
        });
        expect(view.notice).toBeNull();
        expect(view.manageUrl).toBe('https://www.ptbk.io/cs/pricing/predplatne');
    });

    it('notices more engines than covered, without blocking another one', async () => {
        const harness = websiteHarness();
        const { browser } = await linkedOwner(harness, [grant()]);
        await linkEngine(harness, browser);
        await linkEngine(harness, browser);
        expect(await license(browser)).toMatchObject({
            notice: 'exceeded',
            coverage: { engines: { used: 2, covered: 1 } },
        });
        await linkEngine(harness, browser);
    });

    it('keeps the last snapshot through an outage and says it is stale, then unknown without one', async () => {
        const harness = websiteHarness();
        const { browser } = await linkedOwner(harness, [grant()]);
        const fresh = await license(browser);
        expect(fresh.state).toBe('current');
        harness.clock.advance(901_000);
        harness.website.outage = 503;
        const stale = await license(browser);
        expect(stale).toMatchObject({ state: 'stale', checkedAt: fresh.checkedAt, grants: fresh.grants });
        harness.website.outage = null;
        expect((await license(browser)).state).toBe('current');

        const other = websiteHarness();
        other.website.outage = 503;
        const { browser: unknown } = await linkedOwner(other);
        expect(await license(unknown)).toMatchObject({ state: 'unknown', grants: [], coverage: null, notice: null });
    });

    it('reads the cached snapshot within refreshAfterSeconds instead of asking the website', async () => {
        const harness = websiteHarness();
        const { browser } = await linkedOwner(harness, [grant()]);
        await license(browser);
        await license(browser);
        expect(harness.website.calls.filter((call) => call.endsWith('/licenses'))).toHaveLength(1);
    });

    it('notices an expired trial, and still lets the engine run and new ones link', async () => {
        const harness = websiteHarness();
        const trialEnd = new Date(harness.clock.nowMs() + 2 * DAY).toISOString();
        const { browser } = await linkedOwner(harness, [grant({}, trialEnd)]);
        await linkEngine(harness, browser);
        expect((await license(browser)).notice).toBeNull();
        harness.clock.advance(2 * DAY);
        expect(await license(browser)).toMatchObject({ notice: 'expired', grants: [{ active: false }] });
        await linkEngine(harness, browser);
    });
});

describe('billing website: licence check points', () => {
    const invite = (browser: TestBrowser, emails: readonly string[]) =>
        browser.request('POST', '/api/invites', { emails, role: 'member', teamIds: [] });

    it('advisory (the default): warns in the licence view, and links and invites beyond the licence', async () => {
        const harness = websiteHarness();
        const { browser } = await linkedOwner(harness, [grant({ engineProjects: 1, controllingUsers: 1 })]);
        await linkEngine(harness, browser);
        expect(await license(browser)).toMatchObject({
            enforcement: 'advisory',
            checks: {
                engineLink: { outcome: 'warn', reason: 'over-limit' },
                memberInvite: { outcome: 'warn', reason: 'over-limit' },
            },
        });
        const callsBefore = harness.website.calls.length;
        await linkEngine(harness, browser);
        expect((await invite(browser, ['eve@example.test'])).status).toBe(200);
        // The gate does not read the licence in advisory mode; only the screens do.
        expect(harness.website.calls).toHaveLength(callsBefore);
    });

    it('enforce: refuses a new engine or person beyond the licence, never what already runs', async () => {
        const harness = websiteHarness('enforce');
        const { browser } = await linkedOwner(harness, [grant({ engineProjects: 1, controllingUsers: 2 })]);
        expect((await license(browser)).checks.engineLink).toEqual({ outcome: 'ok', reason: null });
        await linkEngine(harness, browser);
        expect((await license(browser)).checks).toEqual({
            engineLink: { outcome: 'deny', reason: 'over-limit' },
            memberInvite: { outcome: 'ok', reason: null },
        });
        const refused = await browser.request('POST', '/api/engines/link-codes');
        expect(refused.status).toBe(403);
        expect(problemCode(refused)).toBe('engine-limit');
        const eligibility = await browser.request('GET', '/api/engines/link-eligibility');
        expect(eligibility.body).toMatchObject({ eligibility: 'engine-limit' });

        const tooMany = await invite(browser, ['eve@example.test', 'fay@example.test']);
        expect(tooMany.status).toBe(403);
        expect(problemCode(tooMany)).toBe('license-limit');
        expect((await invite(browser, ['eve@example.test'])).status).toBe(200);

        const engines = await browser.request('GET', '/api/engines');
        expect(engines.status).toBe(200);
    });

    it('enforce: lets an organization link when the website does not answer', async () => {
        const harness = websiteHarness('enforce');
        const { browser } = await linkedOwner(harness);
        harness.website.outage = 503;
        expect((await license(browser)).checks.engineLink).toEqual({ outcome: 'ok', reason: null });
        await linkEngine(harness, browser);
    });

    it('enforce: refuses to link an engine without a linked ptbk.io account', async () => {
        const harness = websiteHarness('enforce');
        const browser = harness.browser();
        await signUp(harness, browser);
        const refused = await browser.request('POST', '/api/engines/link-codes');
        expect(refused.status).toBe(403);
        expect(problemCode(refused)).toBe('not-entitled');
    });
});
