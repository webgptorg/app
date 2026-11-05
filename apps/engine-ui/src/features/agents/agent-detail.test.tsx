import { KNOWN_CAPABILITIES, PERMISSIONS } from '@ptbk/engine-api';
import { builtInAgents } from '@ptbk/engine-api/in-memory';
import type { AgentId, Permission } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { describe, expect, it } from 'vitest';

import { FEATURES } from '../../app/features';
import { defineFeature } from '../../app/registry/feature';
import type { AgentLiveState, FeatureDefinition, RoutePath } from '../../app/registry/feature';
import { expectNoAxeViolations } from '../../testing/axe';
import { createAgentsEngine } from '../../testing/agents-engine';
import type { AgentsEngineOptions } from '../../testing/agents-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { FORMER_CORE_CAPABILITIES, problemResponse, TEST_NOW } from '../../testing/test-engine-api';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

const label = (text: string) => () => text;

/** The agent page's own header (identity, state, primary actions), not the shell's. */
const agentHeader = () => screen.getAllByRole('heading', { level: 1 })[0]?.closest('header') as HTMLElement;

const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

async function renderAgent(
    path = '/agents/agent-001',
    options: AgentsEngineOptions & { readonly features?: readonly FeatureDefinition[] } = {},
) {
    const engine = createAgentsEngine({ agentCount: 6, ...options });
    const app = renderWithProviders({
        path,
        engineApi: engine.client,
        ...(options.features === undefined ? {} : { features: options.features }),
    });
    await screen.findByRole('tablist');
    return { ...app, engine };
}

const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

describe('agent tabs', { timeout: TIMEOUT_MS }, () => {
    it('shows all eight tabs in the order of the design brief with every capability and permission', async () => {
        await renderAgent('/agents/agent-001', { features: FEATURES });
        expect(tabNames()).toEqual([
            'Overview',
            'Chat',
            'Runs',
            'Files',
            'Triggers',
            'Integrations',
            'Book',
            'Settings',
        ]);
        expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('tab', { name: 'Runs' }).getAttribute('href')).toBe('/agents/agent-001/runs');
    });

    it('shows only Overview and Chat on an engine that advertises no capability', async () => {
        await renderAgent('/agents/agent-001', { features: FEATURES, capabilities: [] });
        expect(tabNames()).toEqual(['Overview', 'Chat']);
    });

    it('adds Book and Settings for an engine that edits Books and manages agents', async () => {
        await renderAgent('/agents/agent-001', { features: FEATURES, capabilities: FORMER_CORE_CAPABILITIES });
        expect(tabNames()).toEqual(['Overview', 'Chat', 'Book', 'Settings']);
    });

    it('hides Runs without runs.read, and a deep link to it says "no access"', async () => {
        await renderAgent('/agents/agent-001/runs', {
            features: FEATURES,
            permissions: allBut('runs.read'),
        });
        expect(tabNames()).not.toContain('Runs');
        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
        expect(screen.getByRole('heading', { level: 1, name: 'Agent 001' })).toBeDefined();
    });

    it('says "not available on this engine" for a deep link to a tab whose capability is missing', async () => {
        await renderAgent('/agents/agent-001/runs', { features: FEATURES, capabilities: [] });
        expect(await screen.findByRole('heading', { level: 1, name: 'Not available on this engine' })).toBeDefined();
    });

    it('checks a tab’s own requirement on a deep link, and says "not found" for a tab nobody registers', async () => {
        // Notes has no route, so the catch-all tab route decides.
        const gated = defineFeature({
            id: 'notes',
            requires: {},
            agentTabs: [
                {
                    id: 'notes',
                    order: 75,
                    label: label('Notes'),
                    to: '/agents/$agentId/notes' as RoutePath,
                    requires: { permission: 'integrations.manage' },
                },
            ],
        });
        await renderAgent('/agents/agent-001/notes', {
            features: [...FEATURES, gated],
            permissions: allBut('integrations.manage'),
        });
        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();

        await renderAgent('/agents/agent-001/nonsense');
        expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeDefined();
    });

    it('says "not found" for a registered tab that is allowed but has no route yet', async () => {
        const notes = defineFeature({
            id: 'notes',
            requires: {},
            agentTabs: [{ id: 'notes', order: 75, label: label('Notes'), to: '/agents/$agentId/notes' as RoutePath }],
        });
        await renderAgent('/agents/agent-001/notes', { features: [...FEATURES, notes] });
        expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeDefined();
    });

    it('lets a registered feature add a tab and an overview card without touching the agents feature', async () => {
        const notes = defineFeature({
            id: 'notes',
            requires: {},
            agentTabs: [{ id: 'notes', order: 75, label: label('Notes'), to: '/agents/$agentId/notes' as RoutePath }],
            agentOverviewCards: [
                {
                    id: 'notes-card',
                    order: 1,
                    component: ({ agentId }: { readonly agentId: AgentId }) => <p>{`Notes for ${agentId}`}</p>,
                },
            ],
        });
        await renderAgent('/agents/agent-001', { features: [...FEATURES, notes] });
        expect(tabNames()).toEqual([
            'Overview',
            'Chat',
            'Runs',
            'Files',
            'Triggers',
            'Integrations',
            'Book',
            'Notes',
            'Settings',
        ]);
        expect(await screen.findByText('Notes for agent-001')).toBeDefined();
    });

    it('moves between tabs with the keyboard and follows a tab link to its route', async () => {
        const { user, router } = await renderAgent();
        const overview = screen.getByRole('tab', { name: 'Overview' });
        overview.focus();
        await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
        const settings = screen.getByRole('tab', { name: 'Settings' });
        expect(document.activeElement).toBe(settings);
        await user.keyboard('{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/agents/agent-001/settings');
        });
        expect(settings.getAttribute('aria-selected')).toBe('true');
        expect(await screen.findByRole('heading', { level: 2, name: 'Sharing' })).toBeDefined();
    });
});

describe('agent overview', { timeout: TIMEOUT_MS }, () => {
    it('shows identity, state, visibility, creator, times, last activity and model', async () => {
        const { engine } = await renderAgent('/agents/agent-003');
        expect(screen.getByRole('heading', { level: 1, name: 'Agent 003' })).toBeDefined();
        const details = screen.getByRole('region', { name: 'Details' });
        expect(await within(details).findByText('Jana Nováková')).toBeDefined();
        // With runs@1 the state comes from the agent's runs, and agent-003 has none.
        expect(within(details).getAllByText('Idle').length).toBeGreaterThan(0);
        expect(within(details).getByText('Private')).toBeDefined();
        expect(within(details).getByText('Handles research notes')).toBeDefined();
        expect(await within(details).findByText('No activity yet')).toBeDefined();
        expect(within(details).getByText('Model')).toBeDefined();
        expect(engine.spies.get).toHaveBeenCalledWith('agent-003', expect.anything());
    });

    it('shows when the agent was last active, and leaves the model out without runs', async () => {
        // Member activity needs members@1; the engine lists none without it.
        const engine = createAgentsEngine({ agentCount: 2, capabilities: [KNOWN_CAPABILITIES.members] });
        engine.controller.appendActivity({
            kind: 'member.joined',
            agentId: 'agent-001',
            actor: { kind: 'system' },
            memberId: 'member-jana',
            displayName: 'Jana',
        });
        renderWithProviders({ path: '/agents/agent-001', engineApi: engine.client });
        const details = await screen.findByRole('region', { name: 'Details' });
        const lastActivity = within(details).getByText('Last activity').nextElementSibling as HTMLElement;
        expect(await within(lastActivity).findByRole('time')).toBeDefined();
        expect(within(details).queryByText('Model')).toBeNull();
    });

    it('keeps the rest of the overview when one card fails, and retries that card alone', async () => {
        let fail = true;
        function Flaky(): never | React.JSX.Element {
            if (fail) throw new Error('card bug');
            return <p>{'Flaky card'}</p>;
        }
        const cards = defineFeature({
            id: 'cards',
            requires: {},
            agentOverviewCards: [
                { id: 'flaky', order: 1, component: Flaky },
                { id: 'steady', order: 2, component: () => <p>{'Steady card'}</p> },
            ],
        });
        const { user } = await renderAgent('/agents/agent-001', { features: [...FEATURES, cards] });
        expect(await screen.findByText('This card could not be shown')).toBeDefined();
        expect(screen.getByText('Steady card')).toBeDefined();
        expect(screen.getByRole('region', { name: 'Details' })).toBeDefined();

        fail = false;
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Flaky card')).toBeDefined();
    });

    it('fetches a card’s failed query again on retry', async () => {
        let calls = 0;
        function Remote() {
            const { data } = useSuspenseQuery({
                queryKey: ['test-card'],
                queryFn: () => {
                    calls += 1;
                    return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve('Remote card');
                },
                retry: false,
            });
            return <p>{data}</p>;
        }
        const cards = defineFeature({
            id: 'remote',
            requires: {},
            agentOverviewCards: [{ id: 'remote', order: 1, component: Remote }],
        });
        const { user } = await renderAgent('/agents/agent-001', { features: [...FEATURES, cards] });
        expect(await screen.findByText('This card could not be shown')).toBeDefined();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Remote card')).toBeDefined();
        expect(calls).toBe(2);
    });

    it('has no axe violations', async () => {
        const { container } = await renderAgent('/agents/agent-001', { features: FEATURES });
        await screen.findByText('No activity yet');
        await expectNoAxeViolations(container);
    });
});

describe('agent live state', { timeout: TIMEOUT_MS }, () => {
    // The real runs provider would win over the fake one, being registered first.
    const WITHOUT_RUNS = FEATURES.filter((feature) => feature.id !== 'runs');

    function createFakeRunsState(initial: AgentLiveState) {
        let state = initial;
        const listeners = new Set<() => void>();
        return {
            set(next: AgentLiveState) {
                state = next;
                for (const listener of listeners) listener();
            },
            feature: defineFeature({
                id: 'fake-runs',
                requires: { capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' },
                agentStatusProvider: {
                    useAgentLiveState: () =>
                        useSyncExternalStore(
                            (listener) => {
                                listeners.add(listener);
                                return () => listeners.delete(listener);
                            },
                            () => state,
                        ),
                    useAgentStop: () => null,
                },
            }),
        };
    }

    it('follows the registered provider when the engine advertises runs@1', async () => {
        const runs = createFakeRunsState('working');
        const { engine } = await renderAgent('/agents/agent-001', { features: [...WITHOUT_RUNS, runs.feature] });
        const header = agentHeader();
        expect(within(header).getByText('Working')).toBeDefined();
        act(() => {
            runs.set('failed');
        });
        expect(within(header).getByText('Failed')).toBeDefined();
        expect(engine.spies.getStatus).not.toHaveBeenCalled();
    });

    it('follows the draft status endpoint and agent.status events without runs@1', async () => {
        const runs = createFakeRunsState('working');
        const { engine } = await renderAgent('/agents/agent-001', {
            features: [...WITHOUT_RUNS, runs.feature],
            capabilities: [],
        });
        const header = agentHeader();
        expect(await within(header).findByText('Running')).toBeDefined();
        const calls = engine.spies.getStatus.mock.calls.length;
        engine.controller.emit({
            type: 'agent.status',
            agentId: 'agent-001',
            state: 'error',
            since: TEST_NOW.toISOString(),
        });
        expect(await within(header).findByText('Error')).toBeDefined();
        expect(engine.spies.getStatus.mock.calls.length).toBe(calls);
    });

    it('shows a state from a newer engine as unknown, with its raw value', async () => {
        const runs = createFakeRunsState('sleeping' as AgentLiveState);
        await renderAgent('/agents/agent-001', { features: [...WITHOUT_RUNS, runs.feature] });
        expect(within(agentHeader()).getByText('Unknown (sleeping)')).toBeDefined();
    });

    it('shows the state as unknown when the engine cannot report it', async () => {
        const engine = createAgentsEngine({ agentCount: 2, capabilities: [] });
        engine.spies.getStatus.mockImplementation(() => problemResponse('validation-failed'));
        renderWithProviders({ path: '/agents/agent-001', engineApi: engine.client });
        const header = (await screen.findByRole('tablist'), agentHeader());
        expect(await within(header).findByText('Unknown')).toBeDefined();
    });

    it('stops a running agent from the header through the draft endpoint, and offers no Start after', async () => {
        const { user, engine } = await renderAgent('/agents/agent-001', { capabilities: [] });
        const header = agentHeader();
        await user.click(await within(header).findByRole('button', { name: 'Stop' }));
        expect(await within(header).findByText('Stopped')).toBeDefined();
        expect(await screen.findByText("Stopped Agent 001's work")).toBeDefined();
        expect(engine.spies.stop).toHaveBeenCalledTimes(1);
        expect(within(header).queryByRole('button', { name: /Start|Stop/ })).toBeNull();
    });

    it('offers no Stop for an agent the draft status does not report as running', async () => {
        // Agent 004 is idle and agent 002 stopped (index % 4).
        await renderAgent('/agents/agent-004', { capabilities: [] });
        expect(await within(agentHeader()).findByText('Idle')).toBeDefined();
        expect(within(agentHeader()).queryByRole('button', { name: /Start|Stop/ })).toBeNull();
    });

    it('reports a failed stop and keeps offering it', async () => {
        const engine = createAgentsEngine({ agentCount: 2, capabilities: [] });
        engine.spies.stop.mockImplementationOnce(() => problemResponse('not-found'));
        const { user } = renderWithProviders({ path: '/agents/agent-001', engineApi: engine.client });
        await screen.findByRole('tablist');
        await user.click(await within(agentHeader()).findByRole('button', { name: 'Stop' }));
        expect(await screen.findByText('The agent could not be stopped.')).toBeDefined();
        expect(within(agentHeader()).getByRole('button', { name: 'Stop' })).toBeDefined();
    });

    it('offers no Stop without agents.run', async () => {
        await renderAgent('/agents/agent-001', { capabilities: [], permissions: allBut('agents.run') });
        expect(await within(agentHeader()).findByText('Running')).toBeDefined();
        expect(within(agentHeader()).queryByRole('button', { name: 'Stop' })).toBeNull();
    });
});

describe('agent header', { timeout: TIMEOUT_MS }, () => {
    it('offers Chat as its one primary action and leaves the book to its tab', async () => {
        await renderAgent('/agents/agent-001', { features: FEATURES });
        const header = agentHeader();
        expect(within(header).getByRole('link', { name: 'Chat' }).getAttribute('href')).toBe('/agents/agent-001/chat');
        expect(within(header).queryByRole('link', { name: 'Edit' })).toBeNull();
        expect(screen.getByRole('tab', { name: 'Book' })).toBeDefined();
    });

    it('keeps visibility and delete in the header’s More menu, delete last and apart', async () => {
        const { user } = await renderAgent('/agents/agent-001');
        await user.click(within(agentHeader()).getByRole('button', { name: 'More actions' }));
        const menu = screen.getByRole('menu', { name: 'More actions' });
        const items = within(menu)
            .getAllByRole('menuitem')
            .map((item) => item.textContent);
        expect(items.at(-1)).toBe('Delete agent');
        expect(items).toContain('Make private');
        await user.click(within(menu).getByRole('menuitem', { name: 'Delete agent' }));
        expect(await screen.findByRole('dialog', { name: 'Delete Agent 001?' })).toBeDefined();
    });

    it('has no More menu for a member who may neither share nor delete', async () => {
        await renderAgent('/agents/agent-001', { permissions: allBut('agents.write', 'agents.delete') });
        expect(within(agentHeader()).queryByRole('button', { name: 'More actions' })).toBeNull();
    });

    it('has no More menu on Expert, which the engine itself defines', async () => {
        await renderAgent('/agents/builtin-expert', {
            agents: builtInAgents('member-owner', '2026-09-01T00:00:00.000Z'),
        });
        expect(within(agentHeader()).queryByRole('button', { name: 'More actions' })).toBeNull();
    });

    it('offers no Chat where no feature registers it', async () => {
        await renderAgent('/agents/agent-002', { features: FEATURES.filter((feature) => feature.id !== 'chat') });
        const headers = screen.getAllByRole('heading', { level: 1, name: 'Agent 002' });
        expect(within(headers[0]?.closest('header') as HTMLElement).queryByRole('link', { name: 'Chat' })).toBeNull();
    });
});

describe('agent settings', { timeout: TIMEOUT_MS }, () => {
    it('changes visibility, asking first only when making the agent public', async () => {
        const { user, engine } = await renderAgent('/agents/agent-003/settings');
        const select = await screen.findByRole('combobox', { name: 'Visibility' });
        expect((select as HTMLSelectElement).value).toBe('private');

        await user.selectOptions(select, 'unlisted');
        await waitFor(() => {
            expect((select as HTMLSelectElement).value).toBe('unlisted');
        });
        expect(engine.spies.update).toHaveBeenLastCalledWith(
            'agent-003',
            { visibility: 'unlisted' },
            expect.anything(),
        );

        await user.selectOptions(select, 'public');
        const dialog = await screen.findByRole('dialog', { name: 'Make Agent 003 public?' });
        expect((select as HTMLSelectElement).value).toBe('unlisted');
        await user.click(within(dialog).getByRole('button', { name: 'Make public' }));
        await waitFor(() => {
            expect((select as HTMLSelectElement).value).toBe('public');
        });
        expect(within(agentHeader()).getByText('Public')).toBeDefined();
        expect(document.activeElement).toBe(select);
    });

    it('deletes the agent, then returns to the list and reports it', async () => {
        const { user, router } = await renderAgent('/agents/agent-002/settings');
        await user.click(await screen.findByRole('button', { name: 'Delete Agent 002' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete Agent 002?' });
        expect(within(dialog).getByText(/Its past runs stay in the history/)).toBeDefined();
        await user.type(within(dialog).getByRole('textbox'), 'Agent 002');
        await user.click(within(dialog).getByRole('button', { name: 'Delete Agent 002' }));

        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/agents');
        });
        expect(await screen.findByText('Agent 002 deleted')).toBeDefined();
        expect(await screen.findByRole('link', { name: 'Agent 001' })).toBeDefined();
        expect(screen.queryByRole('link', { name: 'Agent 002' })).toBeNull();
    });

    it('opens the step-up dialog when delete needs a fresh passkey check', async () => {
        const engine = createAgentsEngine({ agentCount: 2 });
        engine.spies.delete.mockImplementation(() => problemResponse('step-up-required'));
        const { user } = renderWithProviders({ path: '/agents/agent-002/settings', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Delete Agent 002' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete Agent 002?' });
        await user.type(within(dialog).getByRole('textbox'), 'Agent 002');
        await user.click(within(dialog).getByRole('button', { name: 'Delete Agent 002' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
    });

    it('is absent without agents.write and agents.delete, and a deep link says "no access"', async () => {
        await renderAgent('/agents/agent-001/settings', { permissions: allBut('agents.write', 'agents.delete') });
        expect(tabNames()).toEqual(['Overview', 'Chat', 'Runs', 'Files', 'Triggers', 'Integrations', 'Book']);
        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
    });

    it('shows only the delete section with agents.delete alone', async () => {
        await renderAgent('/agents/agent-001/settings', { permissions: ['agents.read', 'agents.delete'] });
        expect(await screen.findByRole('button', { name: 'Delete Agent 001' })).toBeDefined();
        expect(screen.queryByRole('combobox', { name: 'Visibility' })).toBeNull();
        expect(screen.queryByRole('region', { name: 'Name and description' })).toBeNull();
        expect(within(agentHeader()).queryByRole('button', { name: /Start|Stop/ })).toBeNull();
    });

    it('points to the book for the name and description, under a title that is not the field label', async () => {
        await renderAgent('/agents/agent-001/settings');
        const identity = await screen.findByRole('region', { name: 'Name and description' });
        expect(within(identity).getByRole('link', { name: 'Edit the book' }).getAttribute('href')).toBe(
            '/agents/agent-001/book',
        );
        const sharing = screen.getByRole('region', { name: 'Sharing' });
        expect(within(sharing).getByRole('combobox', { name: 'Visibility' })).toBeDefined();
    });

    it('has no axe violations', async () => {
        const { container } = await renderAgent('/agents/agent-001/settings');
        await screen.findByRole('combobox', { name: 'Visibility' });
        await expectNoAxeViolations(container);
    });
});

describe('agent not found', { timeout: TIMEOUT_MS }, () => {
    it.each([
        ['an unknown agent', '/agents/agent-999'],
        ['an ID that cannot be one', '/agents/not%20an%20id'],
    ])('explains %s with a way back', async (_, path) => {
        renderWithProviders({ path, engineApi: createAgentsEngine({ agentCount: 1 }).client });
        expect(await screen.findByRole('heading', { level: 1, name: 'Agent not found' })).toBeDefined();
        expect(screen.getByRole('link', { name: 'Back to agents' }).getAttribute('href')).toBe('/agents');
    });

    it('treats a deleted agent as not found', async () => {
        const engine = createAgentsEngine({
            agents: [{ id: 'agent-gone', source: 'Gone\nPERSONA Old', deletedAt: TEST_NOW.toISOString() }],
        });
        renderWithProviders({ path: '/agents/agent-gone', engineApi: engine.client });
        expect(await screen.findByRole('heading', { level: 1, name: 'Agent not found' })).toBeDefined();
    });
});
