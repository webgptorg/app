import { KNOWN_CAPABILITIES, PERMISSIONS, RunId, TriggerId } from '@ptbk/engine-api';
import type { Activity, AgentId, Permission } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { FEATURES } from '../../app/features';
import { defineFeature } from '../../app/registry/feature';
import { visibleFeatures } from '../../app/registry/visibility';
import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';
import { createTriggersEngine, TRIGGER_IDS } from '../../testing/triggers-engine';
import type { TriggersEngine } from '../../testing/triggers-engine';
import { TriggerSearch } from './trigger-search';
import { triggersFeature } from './triggers-feature';

const TIMEOUT_MS = 20_000;
/** The whole app's first render on a loaded machine can take longer than Testing Library's default second. */
const APP_READY_MS = 5_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));
const ALL_CAPABILITIES = Object.values(KNOWN_CAPABILITIES);
const WITHOUT_RUNS = ALL_CAPABILITIES.filter(({ id }) => id !== 'runs');
const access = (permissions: readonly Permission[], capabilities = ALL_CAPABILITIES) => ({
    can: (permission: Permission) => permissions.includes(permission),
    supports: (capability: { readonly id: string; readonly version: number }) =>
        capabilities.some(({ id, version }) => id === capability.id && version === capability.version),
});

/** Renders `content` on an agent's overview, inside the whole app, as the home feed would. */
function renderInApp(engine: TriggersEngine, content: () => ReactNode) {
    const fixture = defineFeature({
        id: 'fixture',
        requires: {},
        agentOverviewCards: [
            { id: 'fixture', order: 0, component: () => <section aria-label="Fixture">{content()}</section> },
        ],
    });
    return renderWithProviders({
        path: '/agents/agent-iris',
        engineApi: engine.client,
        features: [...FEATURES, fixture],
    });
}

describe('registry gating', () => {
    it('shows nav, tab, card, attention, activity and commands only with triggers@1 and triggers.read', () => {
        const full = visibleFeatures(FEATURES, access(PERMISSIONS)).find(({ id }) => id === 'triggers');
        expect(full?.nav?.to).toBe('/triggers');
        expect(full?.nav?.group).toBe('resources');
        expect(full?.agentTabs?.map(({ id, to }) => [id, to])).toEqual([['triggers', '/agents/$agentId/triggers']]);
        expect(full?.agentOverviewCards?.map(({ id }) => id)).toEqual(['triggers.summary']);
        expect(full?.attention?.id).toBe('triggers.failed');
        expect(full?.activityRenderers?.map(({ kind, versions }) => [kind, versions])).toEqual([['trigger.*', [1]]]);
        expect(full?.commands?.map(({ id }) => id)).toEqual([
            'triggers.open',
            'triggers.new-schedule',
            'triggers.pause',
            'triggers.resume',
        ]);

        expect(visibleFeatures(FEATURES, access(allBut('triggers.read'))).some(({ id }) => id === 'triggers')).toBe(
            false,
        );
        const without = ALL_CAPABILITIES.filter(({ id }) => id !== 'triggers');
        expect(visibleFeatures(FEATURES, access(PERMISSIONS, without)).some(({ id }) => id === 'triggers')).toBe(false);
    });

    it('offers only "Go to triggers" without triggers.manage, and pause and resume list exactly what they act on', () => {
        const readOnly = visibleFeatures(FEATURES, access(allBut('triggers.manage'))).find(
            ({ id }) => id === 'triggers',
        );
        expect(readOnly?.commands?.map(({ id }) => id)).toEqual(['triggers.open']);
        const commands = triggersFeature.commands;
        expect(commands.find(({ id }) => id === 'triggers.pause')).toMatchObject({
            to: '/triggers',
            search: { lifecycle: 'active' },
        });
        expect(commands.find(({ id }) => id === 'triggers.resume')).toMatchObject({
            to: '/triggers',
            search: { lifecycle: 'paused' },
        });
        expect(commands.map(({ label }) => label())).toEqual([
            'Go to triggers',
            'New schedule',
            'Pause trigger',
            'Resume trigger',
        ]);
    });
});

describe('trigger search params', () => {
    it('keep known values and drop what they do not know', () => {
        expect(
            TriggerSearch.parse({ kind: 'email', lifecycle: 'failed', agentId: 'agent-ada', cursor: 'abc_-1' }),
        ).toEqual({
            kind: 'email',
            lifecycle: 'failed',
            agentId: 'agent-ada',
            cursor: 'abc_-1',
        });
        expect(TriggerSearch.parse({ kind: 'sms', lifecycle: 'snoozed', agentId: '', cursor: 'a=b' })).toEqual({});
    });
});

describe('trigger activity renderers', { timeout: TIMEOUT_MS }, () => {
    const base = {
        v: 1,
        at: TEST_NOW.toISOString(),
        agentId: 'agent-iris' as AgentId,
        actor: { kind: 'trigger', triggerId: TRIGGER_IDS.weekday },
        triggerId: TriggerId.parse(TRIGGER_IDS.weekday),
        name: '<b>Morning</b> report',
    } as const;
    const ACTIVITIES = [
        { ...base, id: 'a1', kind: 'trigger.fired', runId: RunId.parse('run-morning') },
        { ...base, id: 'a2', kind: 'trigger.failed', error: { code: 'agent-unavailable', summary: 'Nothing ran.' } },
        { ...base, id: 'a3', kind: 'trigger.paused' },
        { ...base, id: 'a4', kind: 'trigger.resumed' },
    ] as unknown as readonly Activity[];
    const [renderer] = triggersFeature.activityRenderers;

    const feed = () => (
        <ul aria-label="Feed">
            {ACTIVITIES.map((activity) => (
                <li key={activity.id}>
                    <renderer.component activity={activity} />
                </li>
            ))}
        </ul>
    );

    it('renders every v1 trigger kind with links to the trigger and, for a fire, its run', async () => {
        renderInApp(createTriggersEngine(), feed);
        const list = await screen.findByRole('list', { name: 'Feed' }, { timeout: APP_READY_MS });
        expect(within(list).getByText('<b>Morning</b> report fired')).toBeDefined();
        expect(within(list).getByText('<b>Morning</b> report failed')).toBeDefined();
        expect(within(list).getByText('Nothing ran.')).toBeDefined();
        expect(within(list).getByText('<b>Morning</b> report was paused')).toBeDefined();
        expect(within(list).getByText('<b>Morning</b> report was resumed')).toBeDefined();
        expect(list.querySelector('b')).toBeNull();
        for (const link of within(list).getAllByRole('link', { name: 'Open trigger' })) {
            expect(link.getAttribute('href')).toBe(`/triggers/${TRIGGER_IDS.weekday}`);
        }
        expect(
            within(list)
                .getAllByRole('link', { name: 'Open run' })
                .map((link) => link.getAttribute('href')),
        ).toEqual(['/runs/run-morning']);
        expect(ACTIVITIES.map((activity) => renderer.summary(activity))).toEqual([
            '<b>Morning</b> report fired',
            '<b>Morning</b> report failed',
            '<b>Morning</b> report was paused',
            '<b>Morning</b> report was resumed',
        ]);
    });

    it('links a fire to its run only when the engine advertises runs@1', async () => {
        renderInApp(createTriggersEngine({ capabilities: WITHOUT_RUNS }), feed);
        const list = await screen.findByRole('list', { name: 'Feed' }, { timeout: APP_READY_MS });
        expect(within(list).getAllByRole('link', { name: 'Open trigger' })).toHaveLength(4);
        expect(within(list).queryByRole('link', { name: 'Open run' })).toBeNull();
    });
});

describe('failed triggers attention', { timeout: TIMEOUT_MS }, () => {
    it('counts failed triggers and points at the filtered list', async () => {
        const Attention = () => {
            const attention = triggersFeature.attention.useAttention();
            return (
                <p>
                    {attention.count} at {attention.to}?lifecycle={attention.search?.['lifecycle']}
                </p>
            );
        };
        renderInApp(createTriggersEngine(), () => <Attention />);
        expect(await screen.findByText('1 at /triggers?lifecycle=failed', {}, { timeout: APP_READY_MS })).toBeDefined();
    });
});

describe('agent overview card', { timeout: TIMEOUT_MS }, () => {
    it('shows the agent’s active triggers with the next fire, and its paused and failed ones', async () => {
        renderWithProviders({ path: '/agents/agent-iris', engineApi: createTriggersEngine().client });
        const card = await screen.findByRole('region', { name: 'Triggers' });
        const value = (label: string) => within(card).getByText(label).nextElementSibling as HTMLElement;
        await waitFor(() => {
            expect(value('Active').textContent).toBe('1');
        });
        expect(value('Next fire').textContent).toMatch(/^Oct 2, 2026, 6:00\sAM/);
        expect(value('Paused').textContent).toBe('0');
        expect(within(value('Failed')).getByRole('link', { name: '1' }).getAttribute('href')).toBe(
            '/agents/agent-iris/triggers?lifecycle=failed',
        );
        expect(within(card).getByRole('link', { name: 'All triggers' }).getAttribute('href')).toBe(
            '/agents/agent-iris/triggers',
        );
    });
});

describe('live updates', { timeout: TIMEOUT_MS }, () => {
    it('refreshes the list from trigger.changed events, without polling', async () => {
        const engine = createTriggersEngine();
        renderWithProviders({ path: '/triggers', engineApi: engine.client });
        const table = await screen.findByRole('table');
        const row = () => within(table).getByRole('link', { name: 'Support inbox' }).closest('tr') as HTMLElement;
        await within(table).findByText('Support inbox');
        expect(within(row()).getAllByText('Never')).toHaveLength(1);
        const calls = engine.spies.list.mock.calls.length;

        act(() => {
            engine.controller.fireTrigger(TRIGGER_IDS.inbox, { subject: 'Hello' });
        });
        await waitFor(() => {
            expect(within(row()).queryByText('Never')).toBeNull();
        });
        expect(engine.spies.list.mock.calls.length).toBe(calls + 1);
    });
});
