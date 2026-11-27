import { LinkCode, REGISTER_PATH } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { LinkCodeView, LinkEligibilityView } from '../../src/shared/api/routes';
import { createAuthHarness, type AuthHarness, type TestBrowser } from '../../src/testing/auth-harness';
import { problemCode, signUp, uniqueEmail } from '../../src/testing/auth-flows';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createTestEngine } from '../../src/testing/test-engine';

/** ADR 0025: the dashboard limits what it creates itself, projects and people, as the plan's `overLimit` says. */
function offPlan(quotas: { readonly engines: number; readonly people: number }, overLimit?: 'block' | 'warn') {
    return {
        features: ['engines.create'],
        quotas: { 'engines.max': quotas.engines, 'custom-domains.max': 0, 'people.max': quotas.people },
        ...(overLimit === undefined ? {} : { overLimit }),
    };
}

async function ownerOn(harness: AuthHarness): Promise<{ readonly browser: TestBrowser; readonly email: string }> {
    const browser = harness.browser();
    const { email } = await signUp(harness, browser);
    return { browser, email };
}

function invite(browser: TestBrowser, emails: readonly string[]) {
    return browser.request('POST', '/api/invites', { emails, role: 'member', teamIds: [] });
}

async function pendingInvites(browser: TestBrowser): Promise<number> {
    return ((await browser.request('GET', '/api/org/members')).body as { invites: unknown[] }).invites.length;
}

async function linkEngine(harness: AuthHarness, browser: TestBrowser): Promise<void> {
    const issued = await browser.request('POST', '/api/engines/link-codes');
    expect(issued.status).toBe(200);
    const engine = await createTestEngine();
    const request = await engine.register(LinkCode.parse((issued.body as LinkCodeView).linkCode));
    expect((await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request)).status).toBe(200);
}

async function eligibilityOf(browser: TestBrowser): Promise<LinkEligibilityView['eligibility']> {
    return ((await browser.request('GET', '/api/engines/link-eligibility')).body as LinkEligibilityView).eligibility;
}

describe('meter limits on what the dashboard creates', () => {
    it('invites up to the people limit and refuses newcomers past it, on a plan that blocks', async () => {
        const harness = createAuthHarness({
            store: createMemoryAuthStore(),
            billing: 'off',
            offPlan: offPlan({ engines: 1, people: 3 }),
        });
        const { browser, email } = await ownerOn(harness);
        expect((await invite(browser, [uniqueEmail(), uniqueEmail()])).status).toBe(200);
        // Pending invitations are not people yet, so only the owner counts against the limit of three.
        const refused = await invite(browser, [uniqueEmail(), uniqueEmail(), uniqueEmail()]);
        expect([refused.status, problemCode(refused)]).toEqual([403, 'people-limit']);
        expect(await pendingInvites(browser)).toBe(2);
        // Someone already in the organization is no new person.
        expect((await invite(browser, [email])).body).toEqual({ results: [{ email, outcome: 'added' }] });
    });

    it('still adds its own people to teams once an organization is over the people limit', async () => {
        const harness = createAuthHarness({
            store: createMemoryAuthStore(),
            billing: 'off',
            offPlan: offPlan({ engines: 1, people: 0 }),
        });
        const { browser, email } = await ownerOn(harness);
        expect((await invite(browser, [email])).body).toEqual({ results: [{ email, outcome: 'added' }] });
        const refused = await invite(browser, [email, uniqueEmail()]);
        expect([refused.status, problemCode(refused)]).toEqual([403, 'people-limit']);
    });

    it('refuses another project past the limit, on a plan that blocks', async () => {
        const harness = createAuthHarness({
            store: createMemoryAuthStore(),
            billing: 'off',
            offPlan: offPlan({ engines: 1, people: 1 }, 'block'),
        });
        const { browser } = await ownerOn(harness);
        await linkEngine(harness, browser);
        expect(await eligibilityOf(browser)).toBe('engine-limit');
        const refused = await browser.request('POST', '/api/engines/link-codes');
        expect([refused.status, problemCode(refused)]).toEqual([403, 'engine-limit']);
    });

    it('lets people and projects past the limits on a plan that only warns', async () => {
        const harness = createAuthHarness({
            store: createMemoryAuthStore(),
            billing: 'off',
            offPlan: offPlan({ engines: 1, people: 1 }, 'warn'),
        });
        const { browser } = await ownerOn(harness);
        expect((await invite(browser, [uniqueEmail()])).status).toBe(200);
        for (let engine = 0; engine < 3; engine++) {
            expect(await eligibilityOf(browser)).toBe('allowed');
            await linkEngine(harness, browser);
        }
    });

    it('leaves people unlimited on a plan without a people quota, such as no subscription at all', async () => {
        const harness = createAuthHarness({ store: createMemoryAuthStore() });
        const { browser } = await ownerOn(harness);
        expect((await invite(browser, [uniqueEmail(), uniqueEmail(), uniqueEmail()])).status).toBe(200);
        // Without a subscription there is no project to link: the plan step, not a limit.
        const refused = await browser.request('POST', '/api/engines/link-codes');
        expect([refused.status, problemCode(refused)]).toEqual([403, 'not-entitled']);
    });
});
