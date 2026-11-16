import { PERMISSIONS } from '@ptbk/engine-api';
import type { EngineApiClient, Permission } from '@ptbk/engine-api';
import { createDemoSeed, createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { createMemoryStorage } from '../../testing/memory-storage';
import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';
import { AGENT_VIEW_STORAGE_KEY } from './agent-view';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

/** The demo engine: Max runs a run, Ada a task, Chatter replies in a chat, and Iris asks the User something. */
function demoEngine(permissions?: readonly Permission[]) {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: createDemoSeed(TEST_NOW),
        ...(permissions === undefined ? {} : { member: { id: 'member-owner', permissions, role: 'member' } }),
    });
    const chats = { ...engine.client.chats };
    const runs = { ...engine.client.runs };
    const agents = { ...engine.client.agents };
    const spies = {
        listAllChats: vi.spyOn(chats, 'listAll'),
        listAgentChats: vi.spyOn(chats, 'list'),
        listRuns: vi.spyOn(runs, 'list'),
        listAgents: vi.spyOn(agents, 'list'),
    };
    const client: EngineApiClient = { ...engine.client, chats, runs, agents };
    return { client, spies };
}

const card = (name: string) => screen.getByRole('button', { name });

async function renderGrid(path = '/agents', engine = demoEngine(), storage = createMemoryStorage()) {
    const app = renderWithProviders({ path, engineApi: engine.client, storage });
    await screen.findByRole('list', { name: 'Your agents' });
    return { ...app, engine };
}

describe('agents grid', { timeout: TIMEOUT_MS }, () => {
    it('is the default view: the member’s agents, then the built-in ones, as cards', async () => {
        await renderGrid();
        const own = screen.getByRole('list', { name: 'Your agents' });
        expect(within(own).getByRole('button', { name: 'Copywriter' })).toBeDefined();
        const builtIn = screen.getByRole('list', { name: 'Built-in' });
        expect(within(builtIn).getByRole('button', { name: 'Chatter' })).toBeDefined();
        expect(screen.queryByRole('table', { name: 'Agents' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('says what each agent is doing from three lists, never one request per card', async () => {
        const { engine } = await renderGrid();
        await waitFor(() => {
            expect(card('Max').textContent).toContain('Working · 1 run');
        });
        expect(card('Ada').textContent).toContain('Working · 1 task');
        expect(card('Chatter').textContent).toContain('Working · 1 chat');
        expect(card('Iris').textContent).toContain('Needs you');
        expect(card('Copywriter').textContent).toContain('Idle');
        expect(engine.spies.listAllChats).toHaveBeenCalledTimes(1);
        expect(engine.spies.listAgentChats).not.toHaveBeenCalled();
        expect(engine.spies.listRuns.mock.calls.map(([query]) => query)).toEqual([{ status: 'running' }]);
    });

    it('narrows the cards with the search, through the engine', async () => {
        const { user, engine } = await renderGrid();
        await user.type(screen.getByRole('searchbox', { name: 'Search agents' }), 'support');
        await waitFor(() => {
            expect(screen.queryByRole('button', { name: 'Copywriter' })).toBeNull();
        });
        expect(card('Max')).toBeDefined();
        expect(engine.spies.listAgents).toHaveBeenCalledWith(
            { origin: 'content', sort: '-updatedAt', q: 'support' },
            expect.anything(),
        );
    });

    it('opens a card into a panel kept in the URL, and closes it on Escape with focus back on the card', async () => {
        const { user, router } = await renderGrid();
        await user.click(card('Max'));
        const panel = await screen.findByRole('dialog', { name: 'Max' });
        expect(router.state.location.search).toEqual({ agent: 'agent-max' });
        expect(within(panel).getByRole('link', { name: 'Open agent' }).getAttribute('href')).toBe('/agents/agent-max');
        expect(within(panel).getByRole('button', { name: 'Chat' })).toBeDefined();
        expect(within(panel).getByRole('region', { name: 'Chats' })).toBeDefined();

        await user.keyboard('{Escape}');
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'Max' })).toBeNull();
        });
        expect(router.state.location.search).toEqual({});
        expect(document.activeElement).toBe(card('Max'));
    });

    it('opens a shared link’s panel at once, with the agent’s running task', async () => {
        await renderGrid('/agents?agent=agent-ada');
        const panel = await screen.findByRole('dialog', { name: 'Ada' });
        const tasks = within(panel).getByRole('region', { name: 'Running tasks' });
        expect(within(tasks).getByRole('link', { name: /Ship billing v2/ })).toBeDefined();
    });

    it('switches to the table, remembers the choice, and lets the URL win', async () => {
        const storage = createMemoryStorage();
        const { user, router, unmount } = await renderGrid('/agents', demoEngine(), storage);
        await user.click(screen.getByRole('button', { name: 'Table' }));
        expect(await screen.findByRole('table', { name: 'Agents' })).toBeDefined();
        expect(router.state.location.search).toEqual({ view: 'table' });
        expect(storage.getItem(AGENT_VIEW_STORAGE_KEY)).toBe('table');
        unmount();

        renderWithProviders({ path: '/agents', engineApi: demoEngine().client, storage });
        expect(await screen.findByRole('table', { name: 'Agents' })).toBeDefined();
        unmount();
        renderWithProviders({ path: '/agents?view=grid', engineApi: demoEngine().client, storage });
        expect(await screen.findByRole('list', { name: 'Your agents' })).toBeDefined();
    });

    it('reads no chats or runs the member may not see, and says only what it knows', async () => {
        const { engine } = await renderGrid(
            '/agents',
            demoEngine(PERMISSIONS.filter((permission) => permission !== 'chats.read' && permission !== 'runs.read')),
        );
        await waitFor(() => {
            expect(card('Ada').textContent).toContain('Working · 1 task');
        });
        expect(card('Max').textContent).toContain('Idle');
        expect(engine.spies.listAllChats).not.toHaveBeenCalled();
        expect(engine.spies.listRuns).not.toHaveBeenCalled();
    });

    it('says "no access" without agents.read and asks the engine for no agents', async () => {
        const engine = demoEngine(PERMISSIONS.filter((permission) => permission !== 'agents.read'));
        renderWithProviders({ path: '/agents', engineApi: engine.client });
        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
        expect(engine.spies.listAgents).not.toHaveBeenCalled();
    });

    it('has no axe violations, with the panel closed and open', async () => {
        const { container, user } = await renderGrid();
        await waitFor(() => {
            expect(card('Max').textContent).toContain('Working');
        });
        await expectNoAxeViolations(container);
        await user.click(card('Max'));
        await expectNoAxeViolations(await screen.findByRole('dialog', { name: 'Max' }));
    });
});
