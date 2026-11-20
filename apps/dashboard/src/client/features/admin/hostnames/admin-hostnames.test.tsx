import { EngineId, Hostname } from '@ptbk/protocol';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes, type CustomHostnameView } from '../../../../shared/api/routes';
import { expectNoAxeViolations } from '../../../testing/axe';
import { adminEngineView, NOW, session } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render-app';
import { ok, problem } from '../../../testing/scripted-api';

const ADMIN = session({ platformRole: 'admin' });
const ENGINE_ID = EngineId.parse('abcdefghijklmnopqrstuvwxyz');
const TARGET = Hostname.parse(`${ENGINE_ID}.engines.ptbk.test`);
const PATH = `/admin/engines/${ENGINE_ID}/hostnames`;
const CLAIM = 'A'.repeat(86);

function hostname(
    overrides: Partial<Omit<CustomHostnameView, 'hostname'>> & { readonly hostname?: string } = {},
): CustomHostnameView {
    return {
        status: 'pending-dns',
        dnsCheckedAt: null,
        createdAt: NOW - 60_000,
        ...overrides,
        hostname: Hostname.parse(overrides.hostname ?? 'agents.customer.example'),
    };
}

function listing(hostnames: readonly CustomHostnameView[]) {
    return ok({
        engineId: ENGINE_ID,
        orgId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
        expectedTarget: TARGET,
        hostnames: [...hostnames],
    });
}

describe('custom domains (platform admin)', () => {
    it('opens an engine by ID from /admin, refusing anything that is not one, and links to its domains', async () => {
        const app = renderApp({
            path: '/admin',
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.adminListHostnames, listing([]));
                api.on(apiRoutes.adminGetEngine, ok({ engine: adminEngineView({ engineId: ENGINE_ID }) }));
            },
        });
        const field = await screen.findByLabelText(/Engine ID/);
        await app.user.type(field, 'not-an-engine');
        await app.user.click(screen.getByRole('button', { name: 'Open' }));
        expect(await screen.findByText('Enter a 26-character project ID.')).toBeTruthy();
        await app.user.clear(field);
        await app.user.type(field, ENGINE_ID.toUpperCase());
        await app.user.click(screen.getByRole('button', { name: 'Open' }));
        expect(await screen.findByRole('heading', { name: 'Project', level: 1 })).toBeTruthy();
        expect(app.history.location.pathname).toBe(`/admin/engines/${ENGINE_ID}`);
        await app.user.click(await screen.findByRole('link', { name: 'Custom domains' }));
        expect(await screen.findByRole('heading', { name: 'Custom domains', level: 1 })).toBeTruthy();
        expect(app.history.location.pathname).toBe(PATH);
    });

    it('lists the hostnames with their status and the CNAME target next to each', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) =>
                api.on(
                    apiRoutes.adminListHostnames,
                    listing([
                        hostname(),
                        hostname({ hostname: 'portal.customer.example', status: 'active', dnsCheckedAt: NOW - 5000 }),
                    ]),
                ),
        });
        const table = within(await screen.findByRole('table', { name: 'Custom domains' }));
        expect(await table.findByText('agents.customer.example')).toBeTruthy();
        expect(table.getByText('Waiting for DNS')).toBeTruthy();
        expect(table.getByText('Active')).toBeTruthy();
        expect(table.getByText('Never')).toBeTruthy();
        expect(table.getAllByText(TARGET)).toHaveLength(2);
        expect(screen.getByRole('button', { name: 'Copy the CNAME target' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('adds a hostname with its claim and reports what the server refused', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.adminListHostnames, listing([]));
                api.once(apiRoutes.adminAddHostname, problem(400, 'bad-claim'), ok({ hostname: hostname() }));
            },
        });
        await screen.findByText('No custom domains');
        await app.user.type(screen.getByLabelText(/^Hostname/), ' Agents.Customer.Example ');
        await app.user.type(screen.getByLabelText(/^Claim signature/), CLAIM);
        await app.user.click(screen.getByRole('button', { name: 'Add domain' }));
        expect(
            await screen.findByText(
                "The claim does not verify: the project's key must sign exactly this hostname and project ID.",
            ),
        ).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Add domain' }));
        expect(await screen.findByText("Domain added. Check DNS once the customer's CNAME is in place.")).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.adminAddHostname)).toEqual([
            { params: { engineId: ENGINE_ID }, body: { hostname: 'Agents.Customer.Example', claimSig: CLAIM } },
            { params: { engineId: ENGINE_ID }, body: { hostname: 'Agents.Customer.Example', claimSig: CLAIM } },
        ]);
        expect(screen.getByLabelText<HTMLInputElement>(/^Hostname/).value).toBe('');
    });

    it('checks the form before sending it', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => api.on(apiRoutes.adminListHostnames, listing([])),
        });
        await screen.findByText('No custom domains');
        await app.user.type(screen.getByLabelText(/^Claim signature/), 'short');
        await app.user.click(screen.getByRole('button', { name: 'Add domain' }));
        expect(await screen.findByText('Enter a hostname.')).toBeTruthy();
        expect(screen.getByText('Enter the 86-character signature the project printed.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.adminAddHostname)).toEqual([]);
    });

    it('shows what DNS found when it does not match, and says when the hostname is active', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.adminListHostnames, listing([hostname()]));
                api.once(
                    apiRoutes.adminCheckHostname,
                    ok({
                        hostname: hostname({ dnsCheckedAt: NOW }),
                        lookup: { kind: 'cname', target: Hostname.parse('relay-1.ptbk.test') },
                    }),
                    ok({ hostname: hostname({ dnsCheckedAt: NOW }), lookup: { kind: 'none' } }),
                    ok({ hostname: hostname({ dnsCheckedAt: NOW }), lookup: { kind: 'error' } }),
                    ok({
                        hostname: hostname({ status: 'active', dnsCheckedAt: NOW }),
                        lookup: { kind: 'cname', target: TARGET },
                    }),
                );
            },
        });
        /** Found anew each time: the row re-renders, and stays busy until the list refetched after a check. */
        const checkAgain = async () => {
            const check = await screen.findByRole('button', { name: 'Check DNS for agents.customer.example' });
            await waitFor(() => {
                expect(check.getAttribute('aria-busy')).toBeNull();
            });
            await app.user.click(check);
        };
        await checkAgain();
        expect(await screen.findByText('Found relay-1.ptbk.test')).toBeTruthy();
        expect(
            screen.getByText('The CNAME of agents.customer.example does not point at the project yet.'),
        ).toBeTruthy();
        await checkAgain();
        expect(await screen.findByText('No CNAME found')).toBeTruthy();
        await checkAgain();
        expect(await screen.findByText('DNS lookup failed')).toBeTruthy();
        expect(screen.getByText('The DNS lookup failed. Try again in a moment.')).toBeTruthy();
        await checkAgain();
        expect(await screen.findByText('agents.customer.example is active.')).toBeTruthy();
        expect(screen.queryByText('DNS lookup failed')).toBeNull();
        expect(app.api.callsTo(apiRoutes.adminCheckHostname)).toHaveLength(4);
    });

    it('removes a hostname after confirmation', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.adminListHostnames, listing([hostname()]));
                api.on(apiRoutes.adminRemoveHostname, ok({}));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Remove agents.customer.example' }));
        const dialog = within(await screen.findByRole('dialog', { name: 'Remove this domain?' }));
        expect(
            dialog.getByText(
                'agents.customer.example stops routing to this project within 5 minutes, when relays refresh their registry.',
            ),
        ).toBeTruthy();
        await app.user.click(dialog.getByRole('button', { name: 'Remove' }));
        expect(await screen.findByText('Domain removed.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.adminRemoveHostname)).toEqual([
            { params: { engineId: ENGINE_ID, hostname: 'agents.customer.example' } },
        ]);
    });

    it('says when no engine has the ID, and offers a retry when the list fails', async () => {
        renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => api.on(apiRoutes.adminListHostnames, problem(404, 'not-found')),
        });
        expect(await screen.findByText('No project has this ID.')).toBeTruthy();
    });

    it('offers a retry when the list cannot be loaded', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => api.on(apiRoutes.adminListHostnames, problem(500, 'internal')),
        });
        expect(await screen.findByText('The domains could not be loaded.', {}, { timeout: 5000 })).toBeTruthy();
        app.api.on(apiRoutes.adminListHostnames, listing([hostname()]));
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('agents.customer.example')).toBeTruthy();
    });

    it('does not exist for anyone else or for a malformed engine ID, and asks the API for nothing', async () => {
        const stranger = renderApp({ path: PATH, session: session() });
        expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
        expect(stranger.api.callsTo(apiRoutes.adminListHostnames)).toEqual([]);
        stranger.unmount();
        const malformed = renderApp({ path: '/admin/engines/NOT-AN-ENGINE/hostnames', session: ADMIN });
        expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
        expect(malformed.api.callsTo(apiRoutes.adminListHostnames)).toEqual([]);
    });
});
