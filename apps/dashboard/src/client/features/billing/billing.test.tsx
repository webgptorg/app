import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { billingView, NOW, session } from '../../testing/fixtures';
import { APP_ORIGIN, renderApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';

const DAY = 86_400_000;
const OWNER = session({ permissions: ['org.read', 'billing.read', 'billing.manage'] });
const READER = session({ permissions: ['org.read', 'billing.read'] });
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_example';
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_example';

const ACTIVE = billingView({
    status: 'active',
    planId: 'standard',
    currentPeriodEnd: NOW + 30 * DAY,
    hasBillingAccount: true,
    canSubscribe: false,
    entitlements: {
        features: ['engines.create'],
        quotas: [
            { quota: 'engines.max', limit: 5, used: 2 },
            { quota: 'custom-domains.max', limit: null, used: null },
        ],
    },
});

function withBilling(view = billingView()) {
    return (api: ScriptedApi) => {
        api.on(apiRoutes.getBilling, ok(view));
    };
}

function notifications() {
    return within(screen.getByRole('region', { name: 'Notifications' }));
}

describe('billing page', () => {
    it('shows the plan, status, renewal and entitlements with usage', async () => {
        const app = renderApp({ path: '/billing', session: OWNER, script: withBilling(ACTIVE) });
        expect(await screen.findByRole('heading', { name: 'Billing', level: 1 })).toBeTruthy();
        expect(await screen.findByText('Active')).toBeTruthy();
        expect(screen.getByText('standard')).toBeTruthy();
        expect(screen.getByText(/^Renews on /)).toBeTruthy();
        const list = within(screen.getByRole('region', { name: 'Included in your plan' }));
        expect(list.getByText('Link new engines')).toBeTruthy();
        expect(list.getByText('Included')).toBeTruthy();
        expect(list.getByText('2 of 5')).toBeTruthy();
        expect(list.getByText('Unlimited')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Manage billing' })).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Plans' })).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
        await expectNoAxeViolations(app.container);
    });

    it('offers the catalogue plans to an org without a subscription', async () => {
        const app = renderApp({ path: '/billing', session: OWNER, script: withBilling() });
        expect(await screen.findByText('No subscription')).toBeTruthy();
        const current = within(screen.getByRole('region', { name: 'Included in your plan' }));
        expect(current.getByText('Not included')).toBeTruthy();
        expect(current.getAllByText('0')).toHaveLength(2);
        const plan = within(screen.getByLabelText('Plan standard includes'));
        expect(plan.getByText('Included')).toBeTruthy();
        expect(plan.getByText('Unlimited')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Subscribe to standard' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('starts Checkout for the chosen plan and leaves for the URL it returns', async () => {
        const app = renderApp({
            path: '/billing',
            session: OWNER,
            script: (api) => {
                withBilling()(api);
                api.on(apiRoutes.billingCheckout, ok({ url: CHECKOUT_URL }));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Subscribe to standard' }));
        await waitFor(() => {
            expect(app.navigations).toEqual([CHECKOUT_URL]);
        });
        expect(app.api.callsTo(apiRoutes.billingCheckout)).toEqual([{ body: { planId: 'standard' } }]);
    });

    it('opens the billing portal', async () => {
        const app = renderApp({
            path: '/billing',
            session: OWNER,
            script: (api) => {
                withBilling(ACTIVE)(api);
                api.on(apiRoutes.billingPortal, ok({ url: PORTAL_URL }));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Manage billing' }));
        await waitFor(() => {
            expect(app.navigations).toEqual([PORTAL_URL]);
        });
        expect(app.api.callsTo(apiRoutes.billingPortal)).toHaveLength(1);
    });

    it('follows a same-origin URL, as the fake adapter returns', async () => {
        const url = `${APP_ORIGIN}/billing?checkout=success`;
        const app = renderApp({
            path: '/billing',
            session: OWNER,
            script: (api) => {
                withBilling()(api);
                api.on(apiRoutes.billingCheckout, ok({ url }));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Subscribe to standard' }));
        await waitFor(() => {
            expect(app.navigations).toEqual([url]);
        });
    });

    it('refuses to leave for a foreign plain-http URL', async () => {
        const app = renderApp({
            path: '/billing',
            session: OWNER,
            script: (api) => {
                withBilling(ACTIVE)(api);
                api.on(apiRoutes.billingPortal, ok({ url: 'http://evil.example/portal' }));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Manage billing' }));
        expect(await notifications().findByText(/unexpected address/)).toBeTruthy();
        expect(app.navigations).toEqual([]);
    });

    it('explains a plan that is no longer offered and reloads the plans', async () => {
        const app = renderApp({
            path: '/billing',
            session: OWNER,
            script: (api) => {
                withBilling()(api);
                api.on(apiRoutes.billingCheckout, problem(400, 'unknown-plan'));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Subscribe to standard' }));
        expect(
            await notifications().findByText('That plan is no longer offered. The list was refreshed.'),
        ).toBeTruthy();
        await waitFor(() => {
            expect(app.api.callsTo(apiRoutes.getBilling).length).toBeGreaterThan(1);
        });
        expect(app.navigations).toEqual([]);
    });

    it('explains an existing subscription and shows the fresh state', async () => {
        const app = renderApp({
            path: '/billing',
            session: OWNER,
            script: (api) => {
                withBilling()(api);
                api.on(apiRoutes.billingCheckout, problem(409, 'already-subscribed'));
            },
        });
        const subscribe = await screen.findByRole('button', { name: 'Subscribe to standard' });
        // Subscribed meanwhile, e.g. in another tab: the refetch after the failure shows it.
        app.api.on(apiRoutes.getBilling, ok(ACTIVE));
        await app.user.click(subscribe);
        expect(await notifications().findByText(/already has a subscription/)).toBeTruthy();
        expect(await screen.findByText('Active')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Subscribe to standard' })).toBeNull();
    });

    it('shows no billing actions without billing.manage', async () => {
        renderApp({ path: '/billing', session: READER, script: withBilling(billingView({ hasBillingAccount: true })) });
        expect(await screen.findByText('No subscription')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Subscribe/ })).toBeNull();
    });

    it('warns about an overdue payment and points to the portal', async () => {
        renderApp({
            path: '/billing',
            session: OWNER,
            script: withBilling({ ...ACTIVE, status: 'past_due' }),
        });
        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText('Your last payment failed')).toBeTruthy();
        expect(screen.getByText('Payment overdue')).toBeTruthy();
    });

    it('warns harder about an unpaid subscription', async () => {
        renderApp({ path: '/billing', session: OWNER, script: withBilling({ ...ACTIVE, status: 'unpaid' }) });
        expect(within(await screen.findByRole('alert')).getByText('Your subscription is unpaid')).toBeTruthy();
    });

    it('says when a cancelled subscription ends, a trial ends or an old one ended', async () => {
        const { unmount } = renderApp({
            path: '/billing',
            session: OWNER,
            script: withBilling({ ...ACTIVE, cancelAtPeriodEnd: true }),
        });
        expect(await screen.findByText(/^Ends on /)).toBeTruthy();
        unmount();
        const trial = renderApp({
            path: '/billing',
            session: OWNER,
            script: withBilling({ ...ACTIVE, status: 'trialing' }),
        });
        expect(await screen.findByText(/^Trial ends on /)).toBeTruthy();
        trial.unmount();
        renderApp({
            path: '/billing',
            session: OWNER,
            script: withBilling(billingView({ status: 'canceled', currentPeriodEnd: NOW - DAY })),
        });
        expect(await screen.findByText(/^Ended on /)).toBeTruthy();
        expect(screen.getByText('Canceled')).toBeTruthy();
    });

    it('counts usage against an unlimited quota and says when there are no plans', async () => {
        renderApp({
            path: '/billing',
            session: OWNER,
            script: withBilling(
                billingView({
                    plans: [],
                    entitlements: { features: [], quotas: [{ quota: 'engines.max', limit: null, used: 3 }] },
                }),
            ),
        });
        expect(await screen.findByText('3, unlimited')).toBeTruthy();
        expect(screen.getByText('No plans are available yet.')).toBeTruthy();
    });

    it('thanks after a completed Checkout and drops unknown search values', async () => {
        const { unmount } = renderApp({ path: '/billing?checkout=success', session: OWNER, script: withBilling() });
        expect(await screen.findByText('Thank you, your subscription is starting')).toBeTruthy();
        unmount();
        const cancelled = renderApp({ path: '/billing?checkout=cancel', session: OWNER, script: withBilling() });
        expect(await screen.findByText('Checkout was cancelled. Nothing was charged.')).toBeTruthy();
        cancelled.unmount();
        renderApp({ path: '/billing?checkout=evil', session: OWNER, script: withBilling() });
        expect(await screen.findByText('No subscription')).toBeTruthy();
        expect(screen.queryByRole('status', { name: /Checkout/ })).toBeNull();
        expect(screen.queryByText(/Checkout was cancelled|Thank you/)).toBeNull();
    });

    it('shows an error with a retry when billing cannot be loaded', async () => {
        const app = renderApp({
            path: '/billing',
            session: OWNER,
            script: (api) => api.on(apiRoutes.getBilling, problem(500, 'internal')),
        });
        expect(await screen.findByText('Billing could not be loaded.', {}, { timeout: 5000 })).toBeTruthy();
        app.api.on(apiRoutes.getBilling, ok(ACTIVE));
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Active')).toBeTruthy();
    });

    it('is in the navigation only for billing.read', async () => {
        const app = renderApp({ path: '/', session: READER, script: withBilling() });
        const nav = within(await screen.findByRole('navigation', { name: 'Main' }));
        await app.user.click(nav.getByRole('link', { name: 'Billing' }));
        expect(await screen.findByRole('heading', { name: 'Billing', level: 1 })).toBeTruthy();
        app.unmount();
        renderApp({ path: '/', session: session(), script: withBilling() });
        const plain = within(await screen.findByRole('navigation', { name: 'Main' }));
        expect(plain.queryByRole('link', { name: 'Billing' })).toBeNull();
    });
});
