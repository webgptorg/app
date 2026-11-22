import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes, type BillingView } from '../../../shared/api/routes';
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
    planName: { en: 'Standard', cs: 'Standard' },
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
        expect(screen.getByText('Standard')).toBeTruthy();
        expect(screen.queryByText('standard')).toBeNull();
        expect(screen.getByText(/^Renews on /)).toBeTruthy();
        const list = within(screen.getByLabelText('Included in your plan'));
        expect(list.getByText('Link new projects')).toBeTruthy();
        expect(list.getByText('Included')).toBeTruthy();
        expect(list.getByText('2 of 5')).toBeTruthy();
        expect(list.getByText('Unlimited')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Manage billing' })).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Plans' })).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
        await expectNoAxeViolations(app.container);
    });

    it('leads with the plan offers when the org has no plan, and no empty subscription', async () => {
        const app = renderApp({ path: '/billing', session: OWNER, script: withBilling() });
        expect(await screen.findByRole('heading', { name: 'Choose a plan to link projects', level: 2 })).toBeTruthy();
        expect(screen.queryByText('No subscription')).toBeNull();
        expect(screen.queryByText('No plan')).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Subscription' })).toBeNull();
        expect(screen.queryByLabelText('Included in your plan')).toBeNull();
        expect(screen.getByText('Payment happens on Stripe; card details never reach Promptbook.')).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Standard', level: 3 })).toBeTruthy();
        expect(screen.getByText('€29.00 per month')).toBeTruthy();
        expect(screen.queryByText('standard')).toBeNull();
        expect(screen.queryByText('none')).toBeNull();
        const plan = within(screen.getByLabelText('Plan Standard includes'));
        expect(plan.getByText('Included')).toBeTruthy();
        expect(plan.getByText('Unlimited')).toBeTruthy();
        expect(plan.getByText('Not included')).toBeTruthy();
        expect(plan.queryByText('0')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Subscribe to Standard' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('shows a yearly price, and says where to see a price the catalogue does not state', async () => {
        const features = ['engines.create'] as const;
        const quotas = [{ quota: 'engines.max', limit: null }] as const;
        renderApp({
            path: '/billing',
            session: OWNER,
            script: withBilling(
                billingView({
                    plans: [
                        {
                            id: 'yearly',
                            name: { en: 'Yearly', cs: 'Roční' },
                            price: { amount: '1200', currency: 'CZK', interval: 'year' },
                            features: [...features],
                            quotas: [...quotas],
                            trialDays: null,
                        },
                        {
                            id: 'custom',
                            name: { en: 'Custom', cs: 'Na míru' },
                            price: null,
                            features: [...features],
                            quotas: [...quotas],
                            trialDays: null,
                        },
                    ],
                }),
            ),
        });
        expect(await screen.findByText('CZK 1,200.00 per year')).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Custom', level: 3 })).toBeTruthy();
        expect(screen.getByText('Price shown on Stripe before you pay')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Subscribe to Custom' })).toBeTruthy();
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
        await app.user.click(await screen.findByRole('button', { name: 'Subscribe to Standard' }));
        await waitFor(() => {
            expect(app.navigations).toEqual([CHECKOUT_URL]);
        });
        expect(app.api.callsTo(apiRoutes.billingCheckout)).toEqual([
            { body: { planId: 'standard', returnTo: 'billing' } },
        ]);
    });

    it('offers a plan’s trial while the organization never had one', async () => {
        const plan = { ...billingView().plans[0], trialDays: 14 } as BillingView['plans'][number];
        const app = renderApp({
            path: '/billing',
            session: OWNER,
            script: (api) => {
                withBilling(billingView({ plans: [plan] }))(api);
                api.on(apiRoutes.billingCheckout, ok({ url: CHECKOUT_URL }));
            },
        });
        const start = await screen.findByRole('button', { name: 'Start your 14-day trial of Standard' });
        expect(start.textContent).toBe('Start your 14-day trial');
        expect(
            screen.getByText('Stripe asks for your card, and nothing is charged until the trial ends.'),
        ).toBeTruthy();
        await expectNoAxeViolations(app.container);
        await app.user.click(start);
        await waitFor(() => {
            expect(app.navigations).toEqual([CHECKOUT_URL]);
        });
    });

    it('offers no second trial', async () => {
        const plan = { ...billingView().plans[0], trialDays: 14 } as BillingView['plans'][number];
        renderApp({
            path: '/billing',
            session: OWNER,
            script: withBilling(billingView({ plans: [plan], trialAvailable: false })),
        });
        expect(await screen.findByRole('button', { name: 'Subscribe to Standard' })).toBeTruthy();
        expect(screen.queryByText(/nothing is charged until the trial ends/)).toBeNull();
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
        await app.user.click(await screen.findByRole('button', { name: 'Subscribe to Standard' }));
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
        await app.user.click(await screen.findByRole('button', { name: 'Subscribe to Standard' }));
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
        const subscribe = await screen.findByRole('button', { name: 'Subscribe to Standard' });
        // Subscribed meanwhile, e.g. in another tab: the refetch after the failure shows it.
        app.api.on(apiRoutes.getBilling, ok(ACTIVE));
        await app.user.click(subscribe);
        expect(await notifications().findByText(/already has a subscription/)).toBeTruthy();
        expect(await screen.findByText('Active')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Subscribe to Standard' })).toBeNull();
    });

    it('shows no billing actions without billing.manage', async () => {
        const { unmount } = renderApp({
            path: '/billing',
            session: READER,
            script: withBilling(billingView({ hasBillingAccount: true })),
        });
        expect(
            await screen.findByText('This organization has no plan yet. An owner can choose one here.'),
        ).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Choose a plan to link projects' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Subscribe/ })).toBeNull();
        unmount();
        renderApp({ path: '/billing', session: READER, script: withBilling(ACTIVE) });
        expect(await screen.findByText('Active')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
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
        expect(screen.getByText('No plan')).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Plans', level: 2 })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Subscribe to Standard' })).toBeTruthy();
    });

    it('counts usage against an unlimited quota and says a plan does not include a quota', async () => {
        renderApp({
            path: '/billing',
            session: OWNER,
            script: withBilling({
                ...ACTIVE,
                entitlements: {
                    features: ['engines.create'],
                    quotas: [
                        { quota: 'engines.max', limit: null, used: 3 },
                        { quota: 'custom-domains.max', limit: 0, used: null },
                    ],
                },
            }),
        });
        const list = within(await screen.findByLabelText('Included in your plan'));
        expect(list.getByText('3 of unlimited')).toBeTruthy();
        expect(list.getByText('Not included')).toBeTruthy();
    });

    it('says when there are no plans to choose from', async () => {
        renderApp({ path: '/billing', session: OWNER, script: withBilling(billingView({ plans: [] })) });
        expect(await screen.findByText('No plans are available yet.')).toBeTruthy();
    });

    it('thanks once after a completed Checkout, mentioning the wait only while the plan is on its way', async () => {
        const app = renderApp({ path: '/billing?checkout=success', session: OWNER, script: withBilling() });
        expect(await screen.findByText('Thank you, your subscription is starting')).toBeTruthy();
        expect(screen.getByText('It can take a moment until the new plan shows here.')).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Next: add a project' })).toBeNull();
        await waitFor(() => {
            expect(app.history.location.search).toBe('');
        });
        expect(screen.getByText('Thank you, your subscription is starting')).toBeTruthy();
        // The webhook lands: the page asks again by itself and the wait note goes.
        app.api.on(apiRoutes.getBilling, ok(ACTIVE));
        expect(await screen.findByText('Active', {}, { timeout: 5000 })).toBeTruthy();
        expect(screen.queryByText('It can take a moment until the new plan shows here.')).toBeNull();
        expect(screen.getByText('Thank you, your subscription is starting')).toBeTruthy();
        app.unmount();
    });

    it('thanks without the wait note when the plan is already there, and not again on reload', async () => {
        const { unmount } = renderApp({
            path: '/billing?checkout=success',
            session: OWNER,
            script: withBilling(ACTIVE),
        });
        expect(await screen.findByText('Active')).toBeTruthy();
        expect(screen.getByText('Thank you, your subscription is starting')).toBeTruthy();
        expect(screen.queryByText('It can take a moment until the new plan shows here.')).toBeNull();
        expect(screen.getByRole('link', { name: 'Next: add a project' }).getAttribute('href')).toBe('/engines');
        unmount();
        renderApp({ path: '/billing', session: OWNER, script: withBilling(ACTIVE) });
        expect(await screen.findByText('Active')).toBeTruthy();
        expect(screen.queryByText('Thank you, your subscription is starting')).toBeNull();
    });

    it('says a cancelled Checkout charged nothing and drops unknown search values', async () => {
        const cancelled = renderApp({ path: '/billing?checkout=cancel', session: OWNER, script: withBilling() });
        expect(await screen.findByText('Checkout was cancelled. Nothing was charged.')).toBeTruthy();
        await waitFor(() => {
            expect(cancelled.history.location.search).toBe('');
        });
        expect(screen.getByText('Checkout was cancelled. Nothing was charged.')).toBeTruthy();
        cancelled.unmount();
        renderApp({ path: '/billing?checkout=evil', session: OWNER, script: withBilling() });
        expect(await screen.findByRole('heading', { name: 'Choose a plan to link projects' })).toBeTruthy();
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
