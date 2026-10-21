import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { problemOrganization, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok, problem } from '../../testing/scripted-api';

const ADMIN = session({ platformRole: 'admin' });

describe('platform admin', () => {
    it('lists the admin tools', async () => {
        const app = renderApp({ path: '/admin', session: ADMIN });
        expect(await screen.findByRole('heading', { name: 'Platform admin', level: 1 })).toBeTruthy();
        await app.user.click(screen.getByRole('link', { name: 'Billing problems' }));
        expect(await screen.findByRole('heading', { name: 'Billing problems', level: 1 })).toBeTruthy();
    });

    it('lists organizations in a problem state for admins', async () => {
        const app = renderApp({
            path: '/admin/billing',
            session: ADMIN,
            script: (api) =>
                api.on(
                    apiRoutes.adminBilling,
                    ok({
                        organizations: [
                            problemOrganization(),
                            problemOrganization({
                                orgId: 'dddddddddddddddddddddddddd',
                                kind: 'team',
                                name: 'Acme',
                                status: 'unpaid',
                                currentPeriodEnd: null,
                            }),
                            problemOrganization({
                                orgId: 'eeeeeeeeeeeeeeeeeeeeeeeeee',
                                kind: 'team',
                                status: 'canceled',
                            }),
                        ],
                    }),
                ),
        });
        const table = within(await screen.findByRole('table', { name: 'Billing problems' }));
        expect(await table.findByText('Acme')).toBeTruthy();
        expect(table.getByText('Personal')).toBeTruthy();
        expect(table.getByText('Unnamed organization')).toBeTruthy();
        expect(table.getByText('cccccccccccccccccccccccccc')).toBeTruthy();
        expect(table.getByText('Payment overdue')).toBeTruthy();
        expect(table.getByText('Unpaid')).toBeTruthy();
        expect(table.getByText('Canceled')).toBeTruthy();
        expect(table.getByText('None')).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('says when no organization has a payment problem', async () => {
        renderApp({
            path: '/admin/billing',
            session: ADMIN,
            script: (api) => api.on(apiRoutes.adminBilling, ok({ organizations: [] })),
        });
        expect(await screen.findByText('No payment problems')).toBeTruthy();
    });

    it('offers a retry when the list cannot be loaded', async () => {
        const app = renderApp({
            path: '/admin/billing',
            session: ADMIN,
            script: (api) => api.on(apiRoutes.adminBilling, problem(500, 'internal')),
        });
        expect(await screen.findByText('The list could not be loaded.', {}, { timeout: 5000 })).toBeTruthy();
        app.api.on(apiRoutes.adminBilling, ok({ organizations: [problemOrganization({ name: 'Acme' })] }));
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Acme')).toBeTruthy();
    });

    it('does not exist for anyone else, and asks the API for nothing', async () => {
        const app = renderApp({ path: '/admin/billing', session: session() });
        expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.adminBilling)).toEqual([]);
    });
});
