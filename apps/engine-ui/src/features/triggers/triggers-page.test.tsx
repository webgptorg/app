import { KNOWN_CAPABILITIES, PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { createFakeMatchMedia } from '../../testing/fake-match-media';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse } from '../../testing/test-engine-api';
import { NARROW_QUERY } from '../shell/use-media-query';
import { createTriggersEngine, FILLER_TRIGGERS, TRIGGER_IDS } from '../../testing/triggers-engine';
import type { TriggersEngine } from '../../testing/triggers-engine';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;
const SEEDED = FILLER_TRIGGERS + 5;

const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));
const READ_ONLY = allBut('triggers.manage');

async function renderTriggers(path = '/triggers', engine: TriggersEngine = createTriggersEngine()) {
    const app = renderWithProviders({ path, engineApi: engine.client });
    await screen.findByRole('table');
    return { ...app, engine };
}

const table = () => screen.getByRole('table');
const rowNames = () =>
    within(table())
        .queryAllByRole('row')
        .slice(1)
        .map((row) => row.querySelector('a[href^="/triggers/"]')?.textContent ?? '');
const rowOf = (name: string) => within(table()).getByRole('link', { name }).closest('tr') as HTMLElement;
const lastListQuery = (engine: TriggersEngine) => engine.spies.list.mock.calls.at(-1)?.[0];

/** A call the test answers when it chooses, so the optimistic state can be seen before the engine's answer. */
function hold<T>(): { readonly promise: Promise<T>; readonly release: (value: T) => void } {
    let release: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

describe('triggers list', { timeout: TIMEOUT_MS }, () => {
    it('lists every trigger newest first and pages through the rest on the engine', async () => {
        const { user, engine, router } = await renderTriggers();
        await within(table()).findByText('Morning report');
        expect(rowNames().slice(0, 5)).toEqual([
            'Morning report',
            'Support inbox',
            'Every quarter hour',
            'Calendar sync',
            'Launch reminder',
        ]);
        expect(rowNames()).toHaveLength(50);
        expect(lastListQuery(engine)).toEqual({ limit: 50 });

        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() => {
            expect(rowNames()).toHaveLength(SEEDED - 50);
        });
        expect(rowNames().at(-1)).toBe(`Nightly import ${String(FILLER_TRIGGERS)}`);
        expect(router.state.location.search).toHaveProperty('cursor');
        expect(lastListQuery(engine)).toMatchObject({ cursor: expect.any(String) as string });
        expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true);
    });

    it('writes kind, state and agent to the URL, sends them to the engine and restores them on reload', async () => {
        const { user, engine, router } = await renderTriggers();
        await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'schedule');
        await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'active');
        await waitFor(() => {
            expect(rowNames()[0]).toBe('Morning report');
        });
        await screen.findByRole('option', { name: 'Iris' });
        await user.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), 'agent-iris');
        await waitFor(() => {
            expect(router.state.location.search).toEqual({
                kind: 'schedule',
                lifecycle: 'active',
                agentId: 'agent-iris',
            });
        });
        await waitFor(() => {
            expect(rowNames()).toEqual(['Morning report']);
        });
        const filtered = lastListQuery(engine);
        expect(filtered).toEqual({ limit: 50, kind: 'schedule', lifecycle: 'active', agentId: 'agent-iris' });

        // A reload: a fresh app at the same URL asks the engine the same question and shows the same controls.
        const reloaded = createTriggersEngine();
        renderWithProviders({ path: router.state.location.href, engineApi: reloaded.client });
        await waitFor(() => {
            expect(reloaded.spies.list).toHaveBeenCalledWith(filtered, expect.anything());
        });
        expect(screen.getAllByRole('combobox', { name: 'Kind' }).at(-1)).toHaveProperty('value', 'schedule');
        expect(screen.getAllByRole('combobox', { name: 'State' }).at(-1)).toHaveProperty('value', 'active');
        expect(screen.getAllByRole('combobox', { name: 'Agent' }).at(-1)).toHaveProperty('value', 'agent-iris');
    });

    it('restores a page of a filtered list from its cursor', async () => {
        const { user, router } = await renderTriggers('/triggers?kind=schedule');
        await within(table()).findByText('Morning report');
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() => {
            expect(router.state.location.search).toMatchObject({
                kind: 'schedule',
                cursor: expect.any(String) as string,
            });
        });
        const reloaded = createTriggersEngine();
        renderWithProviders({ path: router.state.location.href, engineApi: reloaded.client });
        await waitFor(() => {
            expect(reloaded.spies.list).toHaveBeenCalledWith(
                { limit: 50, ...(router.state.location.search as Record<string, string>) },
                expect.anything(),
            );
        });
    });

    it('falls back to no filter for invalid search params instead of failing', async () => {
        const { engine, router } = await renderTriggers(
            '/triggers?kind=fax&lifecycle=asleep&agentId=%21&cursor=%3D%3D',
        );
        expect(lastListQuery(engine)).toEqual({ limit: 50 });
        expect(router.state.location.search).toEqual({});
        expect(screen.getByRole('heading', { level: 1, name: 'Triggers' })).toBeDefined();
    });

    it('starts again from the first page when the engine refuses a stale cursor', async () => {
        const engine = createTriggersEngine();
        engine.spies.list.mockImplementationOnce(() => problemResponse('invalid-cursor'));
        const { router } = renderWithProviders({ path: '/triggers?cursor=stale', engineApi: engine.client });
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
        expect(await within(await screen.findByRole('table')).findByText('Morning report')).toBeDefined();
    });

    it('shows only the agent’s own triggers on its tab, without the agent column or filter', async () => {
        const { engine } = await renderTriggers('/agents/agent-ada/triggers?agentId=agent-max');
        await within(table()).findByText('Support inbox');
        expect(rowNames()).toEqual(['Support inbox', 'Launch reminder']);
        expect(lastListQuery(engine)).toEqual({ limit: 50, agentId: 'agent-ada' });
        expect(within(table()).queryByRole('columnheader', { name: 'Agent' })).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Agent' })).toBeNull();
        expect(screen.getByRole('link', { name: 'New trigger' }).getAttribute('href')).toBe(
            '/triggers/new?agentId=agent-ada',
        );
    });

    it('shows the state as text, the agent, the kind, the schedule in words or the address, and both zones', async () => {
        await renderTriggers();
        await within(table()).findByText('Morning report');
        const morning = rowOf('Morning report');
        expect(within(morning).getByText('Active')).toBeDefined();
        expect(within(morning).getByRole('link', { name: 'Iris' }).getAttribute('href')).toBe('/agents/agent-iris');
        expect(within(morning).getByText('Schedule')).toBeDefined();
        expect(within(morning).getByText('Every weekday at 08:00, Europe/Prague')).toBeDefined();
        // The reader is in UTC; the schedule plans in Prague, so both are shown.
        expect(within(morning).getByText(/^Oct 2, 2026, 6:00\sAM$/)).toBeDefined();
        expect(within(morning).getByText(/^\(Oct 2, 2026, 8:00\sAM, Europe\/Prague\)$/)).toBeDefined();
        expect(morning.textContent).toMatch(/Oct 2, 2026, 6:00\sAM \(Oct 2, 2026, 8:00\sAM, Europe\/Prague\)/);

        const inbox = rowOf('Support inbox');
        expect(within(inbox).getByText('Email')).toBeDefined();
        expect(within(inbox).getByText('trigger-inbox@engine.localhost')).toBeDefined();
        expect(within(inbox).getByText('Not scheduled')).toBeDefined();
        expect(within(rowOf('Every quarter hour')).getByText('Paused')).toBeDefined();
        expect(within(rowOf('Every quarter hour')).getByText('Every 15 minutes')).toBeDefined();
        expect(within(rowOf('Calendar sync')).getByText('Failed')).toBeDefined();
        expect(within(rowOf('Launch reminder')).getByText('Ended')).toBeDefined();
    });

    it('shows a newer engine’s kind and state as it names them', async () => {
        const engine = createTriggersEngine();
        const real = await engine.client.triggers.list({ limit: 50 }, AbortSignal.timeout(1_000));
        if (real.kind !== 'ok') throw new Error('The seed did not list');
        const [first, ...rest] = real.data.items;
        const newer = { ...first, kind: 'unknown', rawKind: 'sms', lifecycle: 'unknown', rawLifecycle: 'snoozed' };
        const items = [newer, ...rest] as typeof real.data.items;
        engine.spies.list.mockImplementation(() => Promise.resolve({ ...real, data: { ...real.data, items } }));
        await renderTriggers('/triggers', engine);
        await within(table()).findByText('Morning report');
        const row = rowOf('Morning report');
        expect(within(row).getByText('sms')).toBeDefined();
        expect(within(row).getByText('snoozed')).toBeDefined();
        expect(within(row).queryByRole('button', { name: /^(Pause|Resume) / })).toBeNull();
    });

    it('shows a skeleton while the first page loads', async () => {
        const engine = createTriggersEngine();
        const pending = hold<Awaited<ReturnType<typeof engine.client.triggers.list>>>();
        engine.spies.list.mockImplementationOnce(() => pending.promise);
        renderWithProviders({ path: '/triggers', engineApi: engine.client });
        const loading = await screen.findByRole('table');
        expect(loading.closest('[aria-busy="true"]') ?? loading.querySelector('[aria-busy="true"]')).not.toBeNull();
        expect(screen.queryByText('Morning report')).toBeNull();
        pending.release(await engine.client.triggers.list({ limit: 50 }, AbortSignal.timeout(1_000)));
        expect(await screen.findByText('Morning report')).toBeDefined();
    });

    it('says there are no triggers yet, globally and on an agent’s tab', async () => {
        const engine = createTriggersEngine({
            seed: { agents: [{ id: 'agent-ada', source: 'Ada\nPERSONA Research' }] },
        });
        renderWithProviders({ path: '/triggers', engineApi: engine.client });
        expect(await screen.findByText('No triggers yet')).toBeDefined();
        expect(screen.getByText(/works without anyone starting a chat/)).toBeDefined();

        renderWithProviders({ path: '/agents/agent-ada/triggers', engineApi: engine.client });
        expect(await screen.findByText(/This agent starts only from a chat/)).toBeDefined();
    });

    it('says when no trigger matches the filters, and clears them', async () => {
        const { user, router } = await renderTriggers('/triggers?kind=webhook');
        expect(await screen.findByText('No triggers match these filters')).toBeDefined();
        await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
        expect(await screen.findByText('Morning report')).toBeDefined();
    });

    it('shows an error with retry when the list cannot be loaded', async () => {
        const engine = createTriggersEngine();
        engine.spies.list.mockImplementation(() => problemResponse('validation-failed'));
        const { user } = renderWithProviders({ path: '/triggers', engineApi: engine.client });
        expect(await screen.findByText('Triggers could not be loaded.')).toBeDefined();
        engine.spies.list.mockRestore();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Morning report')).toBeDefined();
    });

    it('has no axe violations', async () => {
        // Iris has a running and a failed schedule: every kind of cell and control, without 50 rows for axe to walk.
        const { container } = await renderTriggers('/triggers?agentId=agent-iris');
        await within(table()).findByText('Calendar sync');
        expect(within(table()).getByRole('button', { name: 'Pause Morning report' })).toBeDefined();
        await expectNoAxeViolations(container);
    });
});

describe('pause and resume', { timeout: TIMEOUT_MS }, () => {
    it('pauses at once, then keeps what the engine confirms', async () => {
        const engine = createTriggersEngine();
        const original: typeof engine.client.triggers.pause = (triggerId, signal) =>
            engine.client.triggers.pause(triggerId, signal);
        const pending = hold<undefined>();
        engine.spies.pause.mockImplementationOnce(async (triggerId, signal) => {
            await pending.promise;
            return original(triggerId, signal);
        });
        const { user } = await renderTriggers('/triggers', engine);
        await within(table()).findByText('Morning report');
        await user.click(within(rowOf('Morning report')).getByRole('button', { name: 'Pause Morning report' }));
        expect(within(rowOf('Morning report')).getByText('Paused')).toBeDefined();
        expect(within(rowOf('Morning report')).getByRole('button', { name: 'Resume Morning report' })).toBeDefined();

        pending.release(undefined);
        expect(await screen.findByText('Morning report is paused.')).toBeDefined();
        expect(engine.controller.getTrigger(TRIGGER_IDS.weekday)?.lifecycle).toBe('paused');
        expect(within(rowOf('Morning report')).getByText('Paused')).toBeDefined();
    });

    it('resumes a paused trigger in one tap', async () => {
        const { user, engine } = await renderTriggers();
        await user.click(
            within(rowOf('Every quarter hour')).getByRole('button', { name: 'Resume Every quarter hour' }),
        );
        expect(within(rowOf('Every quarter hour')).getByText('Active')).toBeDefined();
        expect(await screen.findByText('Every quarter hour is running again.')).toBeDefined();
        expect(engine.controller.getTrigger(TRIGGER_IDS.paused)?.lifecycle).toBe('active');
    });

    it('rolls back and reports a refused pause', async () => {
        const engine = createTriggersEngine();
        const pending = hold<undefined>();
        engine.spies.pause.mockImplementationOnce(async () => {
            await pending.promise;
            return problemResponse('validation-failed');
        });
        const { user } = await renderTriggers('/triggers', engine);
        await within(table()).findByText('Morning report');
        await user.click(within(rowOf('Morning report')).getByRole('button', { name: 'Pause Morning report' }));
        expect(within(rowOf('Morning report')).getByText('Paused')).toBeDefined();
        pending.release(undefined);
        expect(await screen.findByText('Morning report could not be paused.')).toBeDefined();
        await waitFor(() => {
            expect(within(rowOf('Morning report')).getByText('Active')).toBeDefined();
        });
        expect(within(rowOf('Morning report')).getByRole('button', { name: 'Pause Morning report' })).toBeDefined();
    });

    it('explains that an ended trigger cannot resume when the engine answers 409 trigger-ended', async () => {
        const engine = createTriggersEngine();
        engine.spies.resume.mockImplementationOnce(() => problemResponse('trigger-ended'));
        const { user } = await renderTriggers('/triggers', engine);
        await within(table()).findByText('Morning report');
        await user.click(within(rowOf('Calendar sync')).getByRole('button', { name: 'Resume Calendar sync' }));
        expect(
            await screen.findByText(
                'This trigger has ended, and an ended trigger cannot be resumed or changed. Create a new one instead.',
            ),
        ).toBeDefined();
        await waitFor(() => {
            expect(within(rowOf('Calendar sync')).getByText('Failed')).toBeDefined();
        });
    });

    it('offers neither pause nor resume for an ended trigger', async () => {
        await renderTriggers();
        await within(table()).findByText('Launch reminder');
        expect(within(rowOf('Launch reminder')).queryByRole('button', { name: /^(Pause|Resume) / })).toBeNull();
    });

    it('keeps pause and resume on each card below 768 px', async () => {
        // The design system's table reads the viewport itself; the shell reads it through the app's port.
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: query === NARROW_QUERY,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        }));
        try {
            renderWithProviders({
                path: '/triggers',
                engineApi: createTriggersEngine().client,
                media: createFakeMatchMedia({ [NARROW_QUERY]: true }),
            });
            const cards = await screen.findByRole('list', { name: 'Triggers' });
            expect(screen.queryByRole('table')).toBeNull();
            expect(await within(cards).findByRole('button', { name: 'Pause Morning report' })).toBeDefined();
            expect(within(cards).getByRole('button', { name: 'Resume Every quarter hour' })).toBeDefined();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('triggers access', { timeout: TIMEOUT_MS }, () => {
    it('without triggers.manage: no new, pause, resume or delete controls, and /triggers/new says "no access"', async () => {
        const engine = createTriggersEngine({ permissions: READ_ONLY });
        await renderTriggers('/triggers', engine);
        await within(table()).findByText('Morning report');
        expect(screen.queryByRole('link', { name: 'New trigger' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^(Pause|Resume) / })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
        expect(within(table()).queryByRole('columnheader', { name: 'Control' })).toBeNull();

        renderWithProviders({
            path: '/triggers/new',
            engineApi: createTriggersEngine({ permissions: READ_ONLY }).client,
        });
        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
    });

    it('without triggers.read: no nav item and /triggers says "no access"', async () => {
        renderWithProviders({ path: '/triggers', permissions: allBut('triggers.read', 'triggers.manage') });
        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
        const nav = screen.getByRole('navigation', { name: 'Main' });
        expect(within(nav).queryByRole('link', { name: 'Triggers' })).toBeNull();
    });

    it('without triggers@1: no nav item, agent tab or card, and /triggers says "not available on this engine"', async () => {
        const without = Object.values(KNOWN_CAPABILITIES).filter(({ id }) => id !== 'triggers');
        const engine = createTriggersEngine({ capabilities: without });
        renderWithProviders({ path: '/triggers', engineApi: engine.client });
        expect(await screen.findByRole('heading', { level: 1, name: 'Not available on this engine' })).toBeDefined();
        const nav = screen.getByRole('navigation', { name: 'Main' });
        expect(within(nav).queryByRole('link', { name: 'Triggers' })).toBeNull();

        renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client });
        await screen.findAllByRole('region', { name: 'Details' });
        expect(screen.queryByRole('tab', { name: 'Triggers' })).toBeNull();
        expect(screen.queryByRole('region', { name: 'Triggers' })).toBeNull();
        expect(engine.spies.list).not.toHaveBeenCalled();
        expect(engine.spies.stats).not.toHaveBeenCalled();
    });
});
