import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { builtInAgents } from '@ptbk/engine-api/in-memory';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { createAgentsEngine, SECOND_MEMBER_NAME, seededAgent } from '../../testing/agents-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';
import { AGENT_COLUMNS_STORAGE_KEY } from './agents-list-page';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

const table = () => screen.getByRole('table', { name: 'Agents' });
const agentLinks = () =>
    within(table())
        .queryAllByRole('link')
        .map((link) => link.querySelector('span:not([aria-hidden])')?.textContent);

async function renderList(path = '/agents', engine = createAgentsEngine()) {
    const app = renderWithProviders({ path, engineApi: engine.client });
    await screen.findAllByRole('link', { name: /Agent \d{3}/ });
    return { ...app, engine };
}

describe('agents list', { timeout: TIMEOUT_MS }, () => {
    it('reaches all 120 agents through paging, including the second member’s, without any filter', async () => {
        const { user, engine } = await renderList();
        const seen = new Set<string | undefined>();
        for (let page = 0; page < 3; page++) {
            await waitFor(() => {
                expect(agentLinks().length).toBeGreaterThan(0);
            });
            for (const name of agentLinks()) seen.add(name);
            if (page < 2) {
                const before = agentLinks()[0];
                await user.click(screen.getByRole('button', { name: 'Next page' }));
                await waitFor(() => {
                    expect(agentLinks()[0]).not.toBe(before);
                });
            }
        }
        expect(seen.size).toBe(120);
        expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
        expect(engine.spies.list.mock.calls.every(([query]) => !('createdBy' in query))).toBe(true);

        await user.click(screen.getByRole('button', { name: 'Previous page' }));
        await waitFor(() => {
            expect(agentLinks()[0]).toBe('Agent 051');
        });
        await user.click(screen.getByRole('button', { name: 'Previous page' }));
        await waitFor(() => {
            expect(agentLinks()[0]).toBe('Agent 001');
        });
        expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(true);
    });

    it('shows agents created by another member by name', async () => {
        await renderList();
        const row = screen.getByRole('link', { name: 'Agent 003' }).closest('tr');
        expect(row).not.toBeNull();
        expect(await within(row as HTMLElement).findByText(SECOND_MEMBER_NAME)).toBeDefined();
        const own = screen.getByRole('link', { name: 'Agent 001' }).closest('tr');
        expect(within(own as HTMLElement).getByText('You')).toBeDefined();
    });

    it('narrows by search, writes q to the URL, and restores the same view on reload', async () => {
        const { user, router, engine } = await renderList();
        await user.type(screen.getByRole('searchbox', { name: 'Search agents' }), 'support');

        await waitFor(() => {
            expect(router.state.location.search).toEqual({ q: 'support' });
        });
        await waitFor(() => {
            expect(agentLinks()).toContain('Agent 002');
        });
        expect(agentLinks()).not.toContain('Agent 001');
        expect(engine.spies.list).toHaveBeenCalledWith(
            { origin: 'content', sort: '-updatedAt', q: 'support' },
            expect.anything(),
        );

        const href = router.state.location.href;
        await renderList(href, createAgentsEngine());
        const searchboxes = screen.getAllByRole('searchbox', { name: 'Search agents' });
        expect((searchboxes.at(-1) as HTMLInputElement).value).toBe('support');
    });

    it('combines the status and visibility filters with search, all sent to the engine', async () => {
        const { user, router, engine } = await renderList('/agents?q=support');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'stopped');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Visibility' }), 'unlisted');

        await waitFor(() => {
            expect(router.state.location.search).toEqual({ q: 'support', status: 'stopped', visibility: 'unlisted' });
        });
        expect(engine.spies.list).toHaveBeenCalledWith(
            { origin: 'content', sort: '-updatedAt', q: 'support', status: 'stopped', visibility: 'unlisted' },
            expect.anything(),
        );
        await waitFor(() => {
            expect(agentLinks()).toEqual([
                'Agent 002',
                'Agent 014',
                'Agent 026',
                'Agent 038',
                'Agent 050',
                'Agent 062',
                'Agent 074',
                'Agent 086',
                'Agent 098',
                'Agent 110',
            ]);
        });

        await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'running');
        // The filters live in the FilterBar now, so the page's own "nothing matches" state answers, with its way back.
        expect(await screen.findByText('No agents match')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Clear search and filters' })).toBeDefined();
    });

    it('falls back to defaults for an unknown status or a garbage cursor instead of crashing', async () => {
        const { router, engine } = await renderList('/agents?status=sleeping&cursor=%25%25%25&visibility=secret');
        expect(router.state.location.search).toEqual({});
        expect(engine.spies.list).toHaveBeenCalledWith({ origin: 'content', sort: '-updatedAt' }, expect.anything());
    });

    it('starts again from the first page when the engine refuses a cursor', async () => {
        const { router, engine } = await renderList('/agents?cursor=bm90LWEtY3Vyc29y');
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
        expect(engine.spies.list).toHaveBeenCalledWith({ origin: 'content', sort: '-updatedAt' }, expect.anything());
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('writes the sort to the URL, sends it to the engine, and keeps the order on reload', async () => {
        const { user, router, engine } = await renderList();
        await user.click(screen.getByRole('button', { name: 'Sort by Name' }));

        await waitFor(() => {
            expect(router.state.location.search).toEqual({ sort: 'name' });
        });
        expect(engine.spies.list).toHaveBeenCalledWith({ origin: 'content', sort: 'name' }, expect.anything());
        await user.click(screen.getByRole('button', { name: 'Name, Sorted ascending' }));
        await waitFor(() => {
            expect(router.state.location.search).toEqual({ sort: '-name' });
        });
        await waitFor(() => {
            expect(agentLinks()[0]).toBe('Agent 120');
        });

        const reloaded = createAgentsEngine();
        await renderList(router.state.location.href, reloaded);
        expect(reloaded.spies.list).toHaveBeenCalledWith({ origin: 'content', sort: '-name' }, expect.anything());
    });

    it('names the edit-time column "Updated", since it sorts by the last save and not by activity', async () => {
        const { user, router } = await renderList();
        expect(screen.queryByRole('columnheader', { name: /Last activity/ })).toBeNull();
        const updated = screen.getByRole('columnheader', { name: /Updated/ });
        await user.click(within(updated).getByRole('button'));
        await waitFor(() => {
            expect(router.state.location.search).toEqual({ sort: 'updatedAt' });
        });
    });

    it('keeps a hidden column hidden after a reload', async () => {
        const { user, storage, unmount } = await renderList();
        expect(screen.getByRole('columnheader', { name: 'Description' })).toBeDefined();
        await user.click(screen.getByRole('button', { name: 'Columns' }));
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Description' }));
        expect(screen.queryByRole('columnheader', { name: 'Description' })).toBeNull();
        expect(storage.getItem(AGENT_COLUMNS_STORAGE_KEY)).toContain('description');
        unmount();

        renderWithProviders({ path: '/agents', engineApi: createAgentsEngine().client, storage });
        await screen.findByRole('link', { name: 'Agent 001' });
        expect(screen.queryByRole('columnheader', { name: 'Description' })).toBeNull();
    });

    it('fetches an agent’s detail once when its row link is hovered, before any navigation', async () => {
        const { user, router, engine } = await renderList();
        expect(engine.spies.get).not.toHaveBeenCalled();
        await user.hover(screen.getByRole('link', { name: 'Agent 002' }));

        await waitFor(() => {
            expect(engine.spies.get).toHaveBeenCalledOnce();
        });
        expect(engine.spies.get.mock.calls[0]?.[0]).toBe('agent-002');
        expect(router.state.location.pathname).toBe('/agents');

        await user.click(screen.getByRole('link', { name: 'Agent 002' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Agent 002' })).toBeDefined();
        expect(engine.spies.get).toHaveBeenCalledOnce();
    });

    it('updates a badge from an agent.status event without asking the engine again', async () => {
        // agent.status drives the badge only without runs@1; with it, U-09's run-based provider does.
        const { engine } = await renderList('/agents', createAgentsEngine({ capabilities: [] }));
        const row = () => screen.getByRole('link', { name: 'Agent 004' }).closest('tr') as HTMLElement;
        expect(await within(row()).findByText('Idle')).toBeDefined();
        const statusCalls = engine.spies.getStatus.mock.calls.length;
        const listCalls = engine.spies.list.mock.calls.length;

        engine.controller.emit({
            type: 'agent.status',
            agentId: 'agent-004',
            state: 'running',
            since: TEST_NOW.toISOString(),
        });

        expect(await within(row()).findByText('Running')).toBeDefined();
        expect(engine.spies.getStatus.mock.calls.length).toBe(statusCalls);
        expect(engine.spies.list.mock.calls.length).toBe(listCalls);
    });

    it('refetches the lists when another member changes an agent', async () => {
        const { engine } = await renderList();
        const listCalls = engine.spies.list.mock.calls.length;
        engine.controller.emit({ type: 'agent.changed', agentId: 'agent-001' });
        // The member's agents and the built-in ones.
        await waitFor(() => {
            expect(engine.spies.list.mock.calls.length).toBe(listCalls + 2);
        });
    });

    // axe walks every node; a dozen rows cover every cell kind without 120 rows' worth of DOM.
    it('has no axe violations', { timeout: 15_000 }, async () => {
        const { container } = await renderList('/agents', createAgentsEngine({ agentCount: 12 }));
        await within(table()).findAllByText('You');
        await expectNoAxeViolations(container);
    });
});

describe('agents list states', { timeout: TIMEOUT_MS }, () => {
    it('invites the first agent when there are none', async () => {
        renderWithProviders({ path: '/agents', engineApi: createAgentsEngine({ agentCount: 0 }).client });
        expect(await screen.findByText('No agents yet')).toBeDefined();
        const cta = within(table()).getByRole('link', { name: 'New agent' });
        expect(cta.getAttribute('href')).toBe('/agents/new');
        expect(screen.queryByRole('search', { name: 'Filters' })).toBeNull();
    });

    it('says when a search finds nothing, with a way back', async () => {
        const { user, router } = renderWithProviders({
            path: '/agents?q=zebra',
            engineApi: createAgentsEngine().client,
        });
        expect(await screen.findByText('No agents match')).toBeDefined();
        expect(screen.getByRole('search', { name: 'Filters' })).toBeDefined();
        await user.click(screen.getByRole('button', { name: 'Clear search and filters' }));
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
        expect(await screen.findByRole('link', { name: 'Agent 001' })).toBeDefined();
    });

    it('shows an error with retry when the list cannot be loaded, and recovers', async () => {
        const engine = createAgentsEngine();
        engine.spies.list.mockImplementation(() => problemResponse('validation-failed'));
        const { user } = renderWithProviders({ path: '/agents', engineApi: engine.client });
        expect(await screen.findByText('The agents could not be loaded.')).toBeDefined();
        engine.spies.list.mockRestore();

        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('link', { name: 'Agent 001' })).toBeDefined();
    });
});

describe('agents list permissions', { timeout: TIMEOUT_MS }, () => {
    it('offers visibility but no delete with agents.write and without agents.delete', async () => {
        const engine = createAgentsEngine({ permissions: ['agents.read', 'agents.run', 'agents.write'] });
        const { user } = await renderList('/agents', engine);
        await user.click(screen.getByRole('button', { name: 'Actions for Agent 001' }));
        const menu = screen.getByRole('menu', { name: 'Actions for Agent 001' });
        expect(within(menu).getByRole('menuitem', { name: /Make (public|private)/ })).toBeDefined();
        expect(within(menu).queryByRole('menuitem', { name: 'Delete agent' })).toBeNull();
    });

    it('has neither a row menu nor "New agent" with only agents.read and agents.run', async () => {
        await renderList('/agents', createAgentsEngine({ permissions: ['agents.read', 'agents.run'] }));
        expect(screen.queryByRole('button', { name: 'Actions for Agent 001' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'New agent' })).toBeNull();
    });

    it('offers "New agent" with agents.write', async () => {
        await renderList('/agents', createAgentsEngine({ permissions: ['agents.read', 'agents.write'] }));
        expect(screen.getByRole('link', { name: 'New agent' }).getAttribute('href')).toBe('/agents/new');
    });

    it('lists the member’s agents first, then a quiet Built-in section with each agent’s role', async () => {
        const engine = createAgentsEngine({
            agents: [seededAgent(1), seededAgent(2), ...builtInAgents('member-owner', '2026-09-01T00:00:00.000Z')],
            capabilities: [KNOWN_CAPABILITIES.files],
        });
        const { container } = await renderList('/agents', engine);
        expect(agentLinks()).toEqual(['Agent 001', 'Agent 002']);
        const builtIn = await screen.findByRole('region', { name: 'Built-in' });
        expect(
            within(builtIn)
                .getAllByRole('link')
                .map((link) => link.textContent),
        ).toEqual(['Chatter', 'Adam', 'Fixer', 'Router', 'Tasker', 'Teacher', 'Expert']);
        expect(
            within(builtIn)
                .getByRole('link', { name: /Chatter/ })
                .getAttribute('href'),
        ).toBe('/agents/builtin-chatter');
        expect(within(builtIn).getByText('Knows Promptbook and this engine, and sets up new projects.')).toBeDefined();
        // Without agent-management@1 nothing can be shared or created from a form.
        expect(screen.queryByRole('combobox', { name: 'Visibility' })).toBeNull();
        expect(screen.queryByRole('columnheader', { name: 'Visibility' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'New agent' })).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('narrows the built-in agents with the search, and hides the section when none match', async () => {
        const engine = createAgentsEngine({
            agents: [
                seededAgent(1),
                { id: 'builtin-chatter', source: 'Chatter\nPERSONA Talks with you first.', origin: 'core' },
            ],
        });
        await renderList('/agents?q=agent', engine);
        await waitFor(() => {
            expect(engine.spies.list).toHaveBeenCalledWith(
                { origin: 'core,system', sort: 'name', limit: 50, q: 'agent' },
                expect.anything(),
            );
        });
        expect(screen.queryByRole('region', { name: 'Built-in' })).toBeNull();
    });
});
