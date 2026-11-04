import { KNOWN_CAPABILITIES, PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { createIntegrationsEngine, FILLER_INTEGRATIONS } from '../../testing/integrations-engine';
import type { IntegrationsEngine } from '../../testing/integrations-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse } from '../../testing/test-engine-api';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;
// axe walks the whole page; on a loaded runner that alone can take longer than a render.
const AXE_TIMEOUT_MS = 60_000;

const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

async function renderIntegrations(path = '/integrations', engine: IntegrationsEngine = createIntegrationsEngine()) {
    const app = renderWithProviders({ path, engineApi: engine.client });
    await screen.findByRole('table');
    return { ...app, engine };
}

const table = () => screen.getByRole('table');
const rowNames = () =>
    within(table())
        .queryAllByRole('row')
        .slice(1)
        .map((row) => row.querySelector('a[href^="/integrations/"]')?.textContent ?? '');
const lastListQuery = (engine: IntegrationsEngine) => engine.spies.list.mock.calls.at(-1)?.[0];

describe('integrations list', { timeout: TIMEOUT_MS }, () => {
    it('lists every integration newest first and pages through the rest on the engine', async () => {
        const { user, engine, router } = await renderIntegrations();
        await within(table()).findByText('Docs search');
        const page = screen.getByRole('region', { name: 'Integrations' });
        const description = document.getElementById(page.getAttribute('aria-describedby') ?? '');
        expect(description?.textContent).toMatch(/\S/);
        expect(rowNames().slice(0, 4)).toEqual(['Docs search', 'Billing repository', 'Ada’s calendar', 'Review bot']);
        expect(rowNames()).toHaveLength(50);
        expect(lastListQuery(engine)).toEqual({ limit: 50 });

        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() => {
            expect(rowNames()).toHaveLength(4 + FILLER_INTEGRATIONS - 50);
        });
        expect(router.state.location.search).toHaveProperty('cursor');
        expect(lastListQuery(engine)).toMatchObject({ cursor: expect.any(String) as string });
    });

    it('shows kind, agent or "All agents", status as text, scopes and last activity', async () => {
        await renderIntegrations();
        const docs = (await within(table()).findByText('Docs search')).closest('tr') as HTMLElement;
        expect(within(docs).getByText('MCP server')).toBeDefined();
        expect(within(docs).getByText('All agents')).toBeDefined();
        expect(within(docs).getByText('Connected')).toBeDefined();
        expect(within(docs).getByText('docs:read, docs:search')).toBeDefined();
        const billing = within(table()).getByText('Billing repository').closest('tr') as HTMLElement;
        expect(within(billing).getByText('Repository')).toBeDefined();
        expect(within(billing).getByText('Needs attention')).toBeDefined();
        expect(within(billing).getByText('Never')).toBeDefined();
        expect((await within(billing).findByRole('link', { name: 'Ada' })).getAttribute('href')).toBe(
            '/agents/agent-ada',
        );
        const off = within(table()).getByText('Review bot').closest('tr') as HTMLElement;
        expect(within(off).getByText('Disabled')).toBeDefined();
    });

    it('writes kind, status and agent to the URL, sends them to the engine and restores them on reload', async () => {
        const { user, engine, router } = await renderIntegrations();
        await user.click(screen.getByRole('button', { name: 'Status' }));
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Error' }));
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Needs attention' }));
        await user.keyboard('{Escape}');
        await waitFor(() => {
            expect(router.state.location.search).toMatchObject({ status: 'needs-attention,error' });
        });
        await waitFor(() => {
            expect(rowNames()).toEqual(['Billing repository', 'Ada’s calendar']);
        });
        expect(lastListQuery(engine)).toMatchObject({ status: 'needs-attention,error' });

        await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'calendar');
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Agent' }), 'agent-ada');
        await waitFor(() => {
            expect(router.state.location.search).toEqual({
                status: 'needs-attention,error',
                kind: 'calendar',
                agentId: 'agent-ada',
            });
        });
        await waitFor(() => {
            expect(rowNames()).toEqual(['Ada’s calendar']);
        });
        const filtered = lastListQuery(engine);
        expect(filtered).toEqual({
            limit: 50,
            status: 'needs-attention,error',
            kind: 'calendar',
            agentId: 'agent-ada',
        });

        const reloaded = createIntegrationsEngine();
        renderWithProviders({ path: router.state.location.href, engineApi: reloaded.client });
        await waitFor(() => {
            expect(reloaded.spies.list).toHaveBeenCalledWith(filtered, expect.anything());
        });
        expect(screen.getAllByRole('button', { name: /^Status\s*2 selected$/ })).not.toHaveLength(0);
    });

    it('opens the attention link with exactly what needs attention', async () => {
        const { engine } = await renderIntegrations('/integrations?status=needs-attention,error');
        await waitFor(() => {
            expect(rowNames()).toEqual(['Billing repository', 'Ada’s calendar']);
        });
        expect(lastListQuery(engine)).toEqual({ limit: 50, status: 'needs-attention,error' });
    });

    it('falls back to no filter for invalid search params instead of failing', async () => {
        const { engine, router } = await renderIntegrations(
            '/integrations?status=error,paused&kind=Bad%20Kind&agentId=%21&cursor=%3D%3D',
        );
        expect(lastListQuery(engine)).toEqual({ limit: 50 });
        expect(router.state.location.search).toEqual({});
    });

    it('starts again from the first page when the engine refuses a stale cursor', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.list.mockImplementationOnce(() => problemResponse('invalid-cursor'));
        const { router } = renderWithProviders({ path: '/integrations?cursor=stale', engineApi: engine.client });
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
        expect(await within(await screen.findByRole('table')).findByText('Docs search')).toBeDefined();
    });

    it('shows what an agent may use on its tab: its own and the engine-wide integrations', async () => {
        const { engine } = await renderIntegrations('/agents/agent-ada/integrations?agentId=agent-max');
        await within(table()).findByText('Docs search');
        expect(rowNames()).toEqual(['Docs search', 'Billing repository', 'Ada’s calendar']);
        expect(lastListQuery(engine)).toEqual({ limit: 50, agentId: 'agent-ada', includeEngineWide: 'true' });
        expect(screen.queryByRole('combobox', { name: 'Agent' })).toBeNull();
    });

    it('shows a skeleton while the first page loads', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.list.mockImplementation(() => new Promise(() => undefined));
        renderWithProviders({ path: '/integrations', engineApi: engine.client });
        const grid = await screen.findByRole('table');
        expect(grid.closest('[aria-busy="true"]')).not.toBeNull();
        expect(within(grid).queryByText('Docs search')).toBeNull();
    });

    it('says there are no integrations yet, globally and on an agent’s tab', async () => {
        const engine = createIntegrationsEngine({ seed: { agents: [{ id: 'agent-ada', source: 'Ada' }] } });
        renderWithProviders({ path: '/integrations', engineApi: engine.client });
        expect(await screen.findByText('No integrations yet')).toBeDefined();
        renderWithProviders({ path: '/agents/agent-ada/integrations', engineApi: engine.client });
        expect(await screen.findByText(/This agent cannot use any integration yet/)).toBeDefined();
    });

    it('says when no integration matches the filters, and clears them', async () => {
        const { user, router } = await renderIntegrations('/integrations?kind=calendar&status=connected');
        expect(await screen.findByText('No integrations match these filters')).toBeDefined();
        await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
    });

    it('shows an error with retry when the list cannot be loaded', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.list.mockImplementation(() => problemResponse('validation-failed'));
        const { user } = renderWithProviders({ path: '/integrations', engineApi: engine.client });
        expect(await screen.findByText('Integrations could not be loaded.')).toBeDefined();
        engine.spies.list.mockRestore();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Docs search')).toBeDefined();
    });

    it('adds through one menu, where a calendar is a disabled item with the reason', async () => {
        const { user } = await renderIntegrations();
        expect(screen.getAllByRole('button', { name: /^Add/ }).map((button) => button.textContent)).toEqual([
            'Add integration',
        ]);
        await user.click(screen.getByRole('button', { name: 'Add integration' }));
        const menu = await screen.findByRole('menu', { name: 'Add integration' });
        expect(
            within(menu)
                .getAllByRole('menuitem')
                .map((item) => item.textContent),
        ).toEqual([
            'MCP server',
            'Repository',
            expect.stringMatching(/^Calendar.*sign-in flow this engine does not offer yet/) as string,
        ]);
        const calendar = within(menu).getByRole('menuitem', { name: /Calendar/ });
        expect(calendar.getAttribute('aria-disabled')).toBe('true');
        await user.click(calendar);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('has no axe violations', { timeout: AXE_TIMEOUT_MS }, async () => {
        const { container } = await renderIntegrations();
        await within(table()).findByText('Docs search');
        await expectNoAxeViolations(container);
    });
});

describe('integrations access', { timeout: TIMEOUT_MS }, () => {
    it('without integrations@1: no nav item, agent tab or card, and /integrations is "not available"', async () => {
        const capabilities = Object.values(KNOWN_CAPABILITIES).filter(({ id }) => id !== 'integrations');
        const engine = createIntegrationsEngine({ capabilities });
        renderWithProviders({ path: '/integrations', engineApi: engine.client });
        expect(await screen.findByRole('heading', { level: 1, name: 'Not available on this engine' })).toBeDefined();
        const nav = screen.getByRole('navigation', { name: 'Main' });
        expect(within(nav).queryByRole('link', { name: 'Integrations' })).toBeNull();

        renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client });
        await screen.findAllByRole('region', { name: 'Details' });
        expect(screen.queryByRole('tab', { name: 'Integrations' })).toBeNull();
        expect(screen.queryByRole('region', { name: 'Integrations' })).toBeNull();
        expect(engine.spies.list).not.toHaveBeenCalled();
        expect(engine.spies.stats).not.toHaveBeenCalled();
    });

    it('without integrations.read: no nav item and /integrations says "no access"', async () => {
        renderWithProviders({ path: '/integrations', permissions: allBut('integrations.read', 'integrations.manage') });
        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
        const nav = screen.getByRole('navigation', { name: 'Main' });
        expect(within(nav).queryByRole('link', { name: 'Integrations' })).toBeNull();
    });

    it('without integrations.manage: no add, row or detail actions', async () => {
        const engine = createIntegrationsEngine({ permissions: allBut('integrations.manage') });
        await renderIntegrations('/integrations', engine);
        await within(table()).findByText('Docs search');
        expect(screen.queryByRole('button', { name: 'Add integration' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();

        renderWithProviders({ path: '/integrations/int-docs', engineApi: engine.client });
        await screen.findByRole('heading', { level: 1, name: 'Docs search' });
        for (const name of ['Disable', 'Enable', 'Check connection', 'Edit', 'More actions']) {
            expect(screen.queryByRole('button', { name })).toBeNull();
        }
    });
});
