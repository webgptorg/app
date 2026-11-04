import { LinkCode, REGISTER_PATH } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { orgIdSchema } from '../../src/domain/ids';
import type { BillingView, LinkCodeView, LinkEligibilityView, SessionView } from '../../src/shared/api/routes';
import { createAuthHarness, type AuthHarness, type TestBrowser } from '../../src/testing/auth-harness';
import { problemCode, signUp } from '../../src/testing/auth-flows';
import { TEST_OFF_PLAN } from '../../src/testing/billing-fixtures';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';
import { stripeEvent } from '../../src/testing/stripe-signature';
import { createTestEngine } from '../../src/testing/test-engine';

const STRIPE_ONLY_ROUTES = [
    ['GET', '/api/billing'],
    ['POST', '/api/billing/checkout'],
    ['POST', '/api/billing/portal'],
    ['GET', '/api/admin/billing'],
] as const;

/** One deployment's data, which a second harness reads after the config changes, as a redeploy would. */
function sharedStores() {
    const store = createMemoryAuthStore();
    return {
        store,
        billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
        registration: createMemoryRegistrationStores({ orgExists: () => true, adminAudit: store.adminAudit }),
    };
}

async function sessionOf(browser: TestBrowser): Promise<SessionView> {
    return (await browser.request('GET', '/api/session')).body as SessionView;
}

async function eligibilityOf(browser: TestBrowser): Promise<LinkEligibilityView['eligibility']> {
    return ((await browser.request('GET', '/api/engines/link-eligibility')).body as LinkEligibilityView).eligibility;
}

async function linkEngine(harness: AuthHarness, browser: TestBrowser): Promise<void> {
    const issued = await browser.request('POST', '/api/engines/link-codes');
    expect(issued.status).toBe(200);
    const engine = await createTestEngine();
    const request = await engine.register(LinkCode.parse((issued.body as LinkCodeView).linkCode));
    expect((await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request)).status).toBe(200);
}

/** The same person in a new deployment's browser: the session cookie is in the shared auth store. */
function sameBrowser(harness: AuthHarness, browser: TestBrowser): TestBrowser {
    const next = harness.browser({ authenticator: browser.authenticator });
    for (const [name, value] of browser.cookies) {
        next.cookies.set(name, value);
    }
    return next;
}

describe('billing off', () => {
    it('tells the SPA that billing is off, and that it is on otherwise', async () => {
        const off = createAuthHarness({ store: createMemoryAuthStore(), billing: 'off' });
        const offBrowser = off.browser();
        await signUp(off, offBrowser);
        expect((await sessionOf(offBrowser)).billingEnabled).toBe(false);

        const on = createAuthHarness({ store: createMemoryAuthStore() });
        const onBrowser = on.browser();
        await signUp(on, onBrowser);
        expect((await sessionOf(onBrowser)).billingEnabled).toBe(true);
    });

    it('lets a new organization link engines at once, up to BILLING_OFF_PLAN, writing nothing to billing', async () => {
        const stores = sharedStores();
        const harness = createAuthHarness({ ...stores, billing: 'off' });
        const browser = harness.browser();
        await signUp(harness, browser);
        const orgId = orgIdSchema.parse((await sessionOf(browser)).activeOrg.id);

        expect(await harness.deps.entitlements.allows(orgId, 'engines.create', AbortSignal.timeout(1000))).toBe(true);
        expect(await harness.deps.entitlements.limit(orgId, 'custom-domains.max', AbortSignal.timeout(1000))).toBe(
            TEST_OFF_PLAN.quotas['custom-domains.max'],
        );
        for (let engine = 0; engine < TEST_OFF_PLAN.quotas['engines.max']; engine++) {
            expect(await eligibilityOf(browser)).toBe('allowed');
            await linkEngine(harness, browser);
        }
        expect(await eligibilityOf(browser)).toBe('engine-limit');
        const refused = await browser.request('POST', '/api/engines/link-codes');
        expect([refused.status, problemCode(refused)]).toEqual([403, 'engine-limit']);

        expect(await stores.billingStore.findCustomer(orgId)).toBeNull();
        expect(await stores.billingStore.findSubscription(orgId)).toBeNull();
    });

    it('mounts no Checkout, portal, billing or webhook route: each answers 404', async () => {
        const harness = createAuthHarness({ store: createMemoryAuthStore(), billing: 'off' });
        const declared = harness.routes.map((route) => route.path);
        for (const [, path] of STRIPE_ONLY_ROUTES) {
            expect(declared).not.toContain(path);
        }
        expect(declared).not.toContain('/webhooks/stripe');
        expect(harness.routes.filter((route) => route.auth === 'stripe-signature')).toEqual([]);

        const browser = harness.browser();
        await signUp(harness, browser);
        for (const [method, path] of STRIPE_ONLY_ROUTES) {
            const response = await browser.request(method, path, method === 'POST' ? { planId: 'starter' } : undefined);
            expect([response.status, problemCode(response)], `${method} ${path}`).toEqual([404, 'not-found']);
        }
    });

    it('accepts no webhook, even one signed with a secret the Stripe adapter would take', async () => {
        const stores = sharedStores();
        const harness = createAuthHarness({ ...stores, billing: 'off' });
        const event = stripeEvent({
            id: 'evt_whileoff',
            type: 'customer.subscription.created',
            object: { id: 'sub_whileoff', object: 'subscription' },
        });
        const response = await harness.webhook(event);
        expect([response.status, problemCode(response)]).toEqual([404, 'not-found']);
        const unsigned = await harness.webhook(event, { signature: 't=1,v1=00' });
        expect(unsigned.status).toBe(404);
        expect(await stores.billingStore.hasEvent('evt_whileoff')).toBe(false);
    });

    it('switches to billing on without a migration: an organization from the off period starts on `none`', async () => {
        const stores = sharedStores();
        const off = createAuthHarness({ ...stores, billing: 'off' });
        const offBrowser = off.browser();
        await signUp(off, offBrowser);
        await linkEngine(off, offBrowser);
        const orgId = orgIdSchema.parse((await sessionOf(offBrowser)).activeOrg.id);

        // The redeploy with `billing: "fake"` stands in for `stripe`: the same service, store and webhook handling.
        const on = createAuthHarness({ ...stores });
        const browser = sameBrowser(on, offBrowser);
        expect((await sessionOf(browser)).billingEnabled).toBe(true);
        const before = (await browser.request('GET', '/api/billing')).body as BillingView;
        expect(before).toMatchObject({
            status: 'none',
            planId: 'none',
            hasBillingAccount: false,
            canSubscribe: true,
            trialAvailable: true,
        });
        expect(before.entitlements.quotas).toContainEqual({ quota: 'engines.max', limit: 0, used: 1 });
        expect(await eligibilityOf(browser)).toBe('not-entitled');
        const engines = await browser.request('GET', '/api/engines');
        expect(engines.status).toBe(200);
        expect(await on.deps.engines.countActive(orgId)).toBe(1);

        expect((await browser.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(200);
        expect(await browser.request('GET', '/api/billing')).toMatchObject({
            body: { status: 'active', planId: 'starter' },
        });
        expect(await eligibilityOf(browser)).toBe('allowed');
        await linkEngine(on, browser);
        expect(await eligibilityOf(browser)).toBe('engine-limit');
    });
});
