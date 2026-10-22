import { createProblem, KNOWN_CAPABILITIES, PERMISSIONS, SemVer } from '@ptbk/engine-api';
import type { ActivityItem, ActivityPageRead, EngineApiResponse, Permission } from '@ptbk/engine-api';
import { setMedia } from '@ptbk/ui';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FEATURES } from '../../app/features';
import { defineFeature } from '../../app/registry/feature';
import { expectNoAxeViolations } from '../../testing/axe';
import { OWNER_ID } from '../../testing/agents-engine';
import { createHomeEngine, seededActivity } from '../../testing/home-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { HOSTILE, runsSeed } from '../../testing/runs-engine';
import { TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));
const Icon = () => null;

afterEach(() => {
    setMedia(REDUCED_MOTION, false);
});

/** The value shown under a count's label. */
function countValue(label: string): string | null {
    const term = screen.getByText(label, { selector: 'dt' });
    return term.nextElementSibling?.querySelector('span')?.textContent ?? null;
}

const feed = () => screen.findByRole('region', { name: 'Activity' });
const liveRegion = () => document.querySelector('[aria-live="polite"].sr-only');

function memberJoined(n: number) {
    return {
        kind: 'member.joined' as const,
        agentId: null,
        actor: { kind: 'system' as const },
        memberId: `member-live-${String(n)}`,
        displayName: `Live member ${String(n)}`,
    };
}

function page(items: readonly ActivityItem[]): Promise<EngineApiResponse<ActivityPageRead>> {
    return Promise.resolve({
        kind: 'ok',
        data: { items, nextCursor: null, dropped: 0 },
    } as EngineApiResponse<ActivityPageRead>);
}

const base = {
    id: 'activity-x',
    at: new Date(TEST_NOW.getTime() - 60_000).toISOString(),
    agentId: 'agent-ada',
    agentName: 'Ada',
    actor: { kind: 'system' },
} as const;

describe('home: control center', { timeout: TIMEOUT_MS }, () => {
    it('greets the owner, counts runs as GET /runs/stats does and meets axe', async () => {
        const engine = createHomeEngine();
        const { container } = renderWithProviders({ path: '/', engineApi: engine.client });

        expect(await screen.findByRole('heading', { level: 1, name: /, Owner$/ })).toBeDefined();
        const stats = await engine.client.runs.stats({}, AbortSignal.timeout(1000));
        if (stats.kind !== 'ok') throw new Error('no stats');
        await waitFor(() => {
            expect(countValue('Running now')).toBe(String(stats.data.running));
        });
        expect(countValue('Queued')).toBe(String(stats.data.queued));
        expect(screen.getByRole('link', { name: 'New agent' }).getAttribute('href')).toBe('/agents/new');
        expect(await within(await feed()).findAllByRole('listitem')).not.toHaveLength(0);
        await expectNoAxeViolations(container);
    });

    it('sums every attention provider and links to each one’s view', async () => {
        const audit = defineFeature({
            id: 'fake-audit',
            requires: {},
            attention: {
                id: 'audit',
                useAttention: () => ({ count: 2, to: '/audit' }),
                label: (count) => `${String(count)} to review`,
            },
        });
        const secrets = defineFeature({
            id: 'fake-secrets',
            requires: {},
            nav: { group: 'admin', order: 99, label: () => 'Vault', icon: Icon, to: '/secrets' },
            attention: {
                id: 'secrets',
                useAttention: () => ({ count: 3, to: '/secrets', search: { status: 'revoked' } }),
            },
        });
        const bare = defineFeature({
            id: 'bare',
            requires: {},
            attention: { id: 'bare', useAttention: () => ({ count: 1, to: '/members' }) },
        });
        const engine = createHomeEngine({ seed: { runs: [] } });
        renderWithProviders({ path: '/', engineApi: engine.client, features: [...FEATURES, audit, secrets, bare] });

        await waitFor(() => {
            expect(countValue('Needs attention')).toBe('6');
        });
        expect(screen.getByRole('link', { name: 'bare: 1' }).getAttribute('href')).toBe('/members');
        expect(screen.getByRole('link', { name: '2 to review' }).getAttribute('href')).toBe('/audit');
        expect(screen.getByRole('link', { name: 'Vault: 3' }).getAttribute('href')).toBe('/secrets?status=revoked');
    });

    it('leaves the run counts out, not at zero, without runs@1', async () => {
        const engine = createHomeEngine({
            capabilities: Object.values(KNOWN_CAPABILITIES).filter(({ id }) => id !== 'runs'),
        });
        renderWithProviders({ path: '/', engineApi: engine.client });

        await feed();
        expect(screen.queryByText('Running now')).toBeNull();
        expect(screen.queryByText('Queued')).toBeNull();
        expect(engine.spies.runStats).not.toHaveBeenCalled();
    });

    it('shows the update banner when GET /security says one is available', async () => {
        const engine = createHomeEngine();
        const current = await engine.client.security.get(AbortSignal.timeout(1000));
        if (current.kind !== 'ok') throw new Error('no security overview');
        engine.controller.updateSecurity({
            update: {
                ...current.data.update,
                status: 'available',
                availableVersion: '9.1.0',
                eligibleAt: '2026-10-02T12:00:00.000Z',
            },
        });
        renderWithProviders({ path: '/', engineApi: engine.client });

        const banner = await screen.findByText(/Version 9\.1\.0 can be installed from/);
        expect(banner).toBeDefined();
        expect(screen.getByRole('link', { name: 'Review the update' }).getAttribute('href')).toBe('/security');
    });

    it('shows the update banner on an engine.update-available event', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        await feed();
        expect(screen.queryByText('Engine update available')).toBeNull();

        act(() => {
            engine.controller.appendActivity({
                kind: 'engine.update-available',
                agentId: null,
                actor: { kind: 'system' },
                version: SemVer.parse('9.2.0'),
            });
        });
        expect(await screen.findByText('Version 9.2.0 is available.')).toBeDefined();
        expect(await within(await feed()).findByText('Engine version 9.2.0 is available')).toBeDefined();
    });

    it('keeps a failing widget to itself and retries it', async () => {
        const engine = createHomeEngine();
        engine.spies.agents.mockImplementation(() =>
            Promise.resolve({ kind: 'problem', problem: createProblem('forbidden') }),
        );
        const { user } = renderWithProviders({ path: '/', engineApi: engine.client });

        const recent = await screen.findByRole('region', { name: 'Recent agents' });
        expect(await within(recent).findByText('This part of the page could not load.')).toBeDefined();
        expect(await within(await feed()).findAllByRole('listitem')).not.toHaveLength(0);
        engine.spies.agents.mockRestore();
        await user.click(within(recent).getByRole('button', { name: 'Try again' }));
        expect(await within(recent).findByRole('link', { name: 'Ada' })).toBeDefined();
    });

    it('shows skeletons shaped like each widget while it loads', async () => {
        const engine = createHomeEngine();
        engine.spies.runStats.mockImplementation(() => new Promise(() => undefined));
        engine.spies.activity.mockImplementation(() => new Promise(() => undefined));
        engine.spies.agents.mockImplementation(() => new Promise(() => undefined));
        renderWithProviders({ path: '/', engineApi: engine.client });

        const counts = await screen.findByRole('region', { name: 'Right now' });
        expect(counts.querySelectorAll('dd[aria-busy="true"]')).toHaveLength(2);
        const recent = await screen.findByRole('region', { name: 'Recent agents' });
        expect(recent.querySelector('[aria-busy="true"]')).not.toBeNull();
        expect((await feed()).querySelector('ul[aria-busy="true"]')?.children).toHaveLength(4);
    });

    it('shows empty states when there is nothing yet, with a way to create the first agent', async () => {
        const engine = createHomeEngine({ activity: [], seed: { agents: [], runs: [], chats: [], messages: [] } });
        renderWithProviders({ path: '/', engineApi: engine.client });

        const recent = await screen.findByRole('region', { name: 'Recent agents' });
        expect(await within(recent).findByText('No agents yet')).toBeDefined();
        expect(within(recent).getByRole('link', { name: 'New agent' }).getAttribute('href')).toBe('/agents/new');
        expect(await within(await feed()).findByText('No activity yet')).toBeDefined();
        await waitFor(() => {
            expect(countValue('Running now')).toBe('0');
        });
    });

    it('keeps a failing run count to its own tile', async () => {
        const engine = createHomeEngine();
        engine.spies.runStats.mockImplementation(() =>
            Promise.resolve({ kind: 'problem', problem: createProblem('forbidden') }),
        );
        const { user } = renderWithProviders({ path: '/', engineApi: engine.client });

        const counts = await screen.findByRole('region', { name: 'Right now' });
        expect(await within(counts).findByText('This part of the page could not load.')).toBeDefined();
        expect(within(counts).getByText('Needs attention')).toBeDefined();
        engine.spies.runStats.mockRestore();
        await user.click(within(counts).getByRole('button', { name: 'Try again' }));
        await waitFor(() => {
            expect(countValue('Running now')).not.toBeNull();
        });
    });

    it('takes the banner down once the engine says it installed the update', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        await feed();
        act(() => {
            engine.controller.appendActivity({
                kind: 'engine.update-available',
                agentId: null,
                actor: { kind: 'system' },
                version: SemVer.parse('9.2.0'),
            });
        });
        expect(await screen.findByText('Version 9.2.0 is available.')).toBeDefined();

        act(() => {
            engine.controller.appendActivity({
                kind: 'engine.updated',
                agentId: null,
                actor: { kind: 'system' },
                fromVersion: SemVer.parse('9.1.0'),
                toVersion: SemVer.parse('9.2.0'),
            });
        });
        await waitFor(() => {
            expect(screen.queryByText('Version 9.2.0 is available.')).toBeNull();
        });
    });

    it('shows a feed that fails with a retry, and the rest of home still renders', async () => {
        const engine = createHomeEngine();
        engine.spies.activity.mockImplementation(() =>
            Promise.resolve({ kind: 'problem', problem: createProblem('forbidden') }),
        );
        renderWithProviders({ path: '/', engineApi: engine.client });

        expect(await within(await feed()).findByText('Activity could not load.')).toBeDefined();
        expect(await screen.findByRole('link', { name: 'Ada' })).toBeDefined();
    });
});

describe('home: member', { timeout: TIMEOUT_MS }, () => {
    it('lists only the member’s queued and running runs, the agents they can use and recent chats', async () => {
        const engine = createHomeEngine({ permissions: allBut('security.read') });
        const { container } = renderWithProviders({ path: '/', engineApi: engine.client });

        const mine = await screen.findByRole('region', { name: 'Your running work' });
        await waitFor(() => {
            expect(within(mine).getAllByRole('listitem').length).toBeGreaterThan(0);
        });
        expect(engine.spies.runs).toHaveBeenCalledWith(
            expect.objectContaining({ createdBy: OWNER_ID, status: 'queued,running' }),
            expect.anything(),
        );
        for (const item of within(mine).getAllByRole('listitem')) {
            expect(item.textContent).toMatch(/Running|Queued|Cancelling/);
        }
        expect(await screen.findByRole('region', { name: 'Your agents' })).toBeDefined();
        expect(await screen.findByRole('link', { name: 'Billing review' })).toBeDefined();
        expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull();
        expect(screen.queryByText('Running now')).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('says when nothing of theirs runs and they have no chats, without offering what they may not do', async () => {
        const engine = createHomeEngine({
            permissions: ['agents.read', 'chats.read', 'runs.read'],
            seed: { runs: [], chats: [], messages: [], agents: [] },
        });
        renderWithProviders({ path: '/', engineApi: engine.client });

        expect(await screen.findByText('Nothing of yours is running or queued.')).toBeDefined();
        expect(await screen.findByText('No chats yet.')).toBeDefined();
        const agents = await screen.findByRole('region', { name: 'Your agents' });
        expect(await within(agents).findByText('No agents yet')).toBeDefined();
        expect(within(agents).queryByRole('link', { name: 'New agent' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'New agent' })).toBeNull();
    });

    it('names an untitled chat and a run whose agent the engine no longer knows', async () => {
        const engine = createHomeEngine({
            permissions: ['agents.read', 'chats.read', 'runs.read'],
            seed: { agents: [...(runsSeed().agents ?? []), { id: 'agent-solo', source: 'Solo' }] },
        });
        const runs = await engine.client.runs.list({ status: 'running' }, AbortSignal.timeout(1000));
        if (runs.kind !== 'ok') throw new Error('no runs');
        engine.spies.runs.mockResolvedValue({
            ...runs,
            data: { ...runs.data, items: runs.data.items.map((run) => ({ ...run, agentName: null })) },
        });
        engine.spies.chats.mockImplementation(async (query, signal) => {
            const chats = await engine.client.chats.list('agent-ada' as never, query, signal);
            return chats.kind === 'ok'
                ? {
                      ...chats,
                      data: { ...chats.data, items: chats.data.items.map((chat) => ({ ...chat, title: ' ' })) },
                  }
                : chats;
        });
        renderWithProviders({ path: '/', engineApi: engine.client });

        const recent = await screen.findByRole('region', { name: 'Recent chats' });
        expect(await within(recent).findByRole('link', { name: 'Untitled chat' })).toBeDefined();
        const solo = await screen.findByRole('link', { name: 'Solo' });
        expect(solo.parentElement?.textContent).toBe('Solo');
        const mine = await screen.findByRole('region', { name: 'Your running work' });
        await waitFor(() => {
            expect(within(mine).getAllByRole('listitem').length).toBeGreaterThan(0);
        });
    });

    it('leaves out running work without runs.read', async () => {
        const engine = createHomeEngine({ permissions: allBut('security.read', 'runs.read') });
        renderWithProviders({ path: '/', engineApi: engine.client });

        expect(await screen.findByRole('region', { name: 'Your agents' })).toBeDefined();
        expect(screen.queryByRole('region', { name: 'Your running work' })).toBeNull();
        expect(engine.spies.runs).not.toHaveBeenCalled();
    });
});

describe('home: activity feed', { timeout: TIMEOUT_MS }, () => {
    it('puts an emitted activity on top without asking the engine again', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        await within(region).findAllByRole('listitem');
        const calls = engine.spies.activity.mock.calls.length;

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
        });
        const items = await within(region).findAllByRole('listitem');
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')[0]?.textContent).toContain('Live member 1 joined');
        });
        expect(items.length).toBeGreaterThan(1);
        expect(engine.spies.activity.mock.calls.length).toBe(calls);
    });

    it('collects new items behind "N new" while the reader is scrolled down', async () => {
        const engine = createHomeEngine();
        const { user } = renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        const before = (await within(region).findAllByRole('listitem')).length;
        const sentinel = region.querySelector('[data-activity-top]') as HTMLElement;
        sentinel.getBoundingClientRect = () => ({ top: -400 }) as DOMRect;
        act(() => {
            window.dispatchEvent(new Event('scroll'));
        });

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
            engine.controller.appendActivity(memberJoined(2));
        });
        const more = await within(region).findByRole('button', { name: '2 new items' });
        expect(within(region).getAllByRole('listitem')).toHaveLength(before);
        expect(within(region).queryByText('Live member 2 joined')).toBeNull();

        await user.click(more);
        expect(within(region).getAllByRole('listitem')).toHaveLength(before + 2);
        expect(within(region).getAllByRole('listitem')[0]?.textContent).toContain('Live member 2 joined');
    });

    it('announces a batch of arrivals once, in one polite live region', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        await within(await feed()).findAllByRole('listitem');
        expect(document.querySelectorAll('[aria-live="polite"].sr-only')).toHaveLength(1);
        expect(liveRegion()?.textContent).toBe('');

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
            engine.controller.appendActivity(memberJoined(2));
            engine.controller.appendActivity(memberJoined(3));
        });
        await waitFor(() => {
            expect(liveRegion()?.textContent).toBe('3 new activities');
        });
    });

    it('announces a single arrival by its summary', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        await within(await feed()).findAllByRole('listitem');

        act(() => {
            engine.controller.appendActivity(memberJoined(7));
        });
        await waitFor(() => {
            expect(liveRegion()?.textContent).toBe('Live member 7 joined');
        });
    });

    it('slides new items in, and only fades them under reduced motion', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        await within(region).findAllByRole('listitem');
        expect(within(region).getAllByRole('listitem')[0]?.className).not.toMatch(/ptbk-activity/);

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
        });
        await within(region).findByText('Live member 1 joined');
        expect(within(region).getAllByRole('listitem')[0]?.className).toMatch(/ptbk-activity-enter/);

        act(() => {
            setMedia(REDUCED_MOTION, true);
            engine.controller.appendActivity(memberJoined(2));
        });
        await within(region).findByText('Live member 2 joined');
        const first = within(region).getAllByRole('listitem')[0]?.className ?? '';
        expect(first).toMatch(/ptbk-activity-fade/);
        expect(first).not.toMatch(/ptbk-activity-enter/);
    });

    it('filters by area with chips bound to the URL, offering only visible areas', async () => {
        const engine = createHomeEngine();
        const { user, router } = renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        const chips = within(within(region).getByRole('group', { name: 'Show activity of' })).getAllByRole('button');
        expect(chips.map((chip) => chip.textContent)).toEqual([
            'All',
            'Runs',
            'Files',
            'Triggers',
            'Integrations',
            'Members',
            'Engine',
        ]);

        await user.click(within(region).getByRole('button', { name: 'Members' }));
        await waitFor(() => {
            expect(router.state.location.search).toEqual({ activity: 'member' });
        });
        expect(engine.spies.activity).toHaveBeenLastCalledWith(
            expect.objectContaining({ kind: 'member.' }),
            expect.anything(),
        );
        expect(within(region).getByRole('button', { name: 'Members' }).getAttribute('aria-pressed')).toBe('true');

        act(() => {
            engine.controller.appendActivity(memberJoined(4));
        });
        expect(await within(region).findByText('Live member 4 joined')).toBeDefined();
        await user.click(within(region).getByRole('button', { name: 'All' }));
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
    });

    it('shows a member without runs.read no run cards and no run chip, even from a careless engine', async () => {
        const engine = createHomeEngine({ permissions: allBut('runs.read') });
        const run = { ...base, kind: 'run.started', v: 1, runId: 'run-completed', source: 'web' };
        engine.spies.activity.mockImplementation(() =>
            page([
                { kind: 'known', activity: run as never },
                { kind: 'known', activity: { ...base, id: 'activity-m', v: 1, ...memberJoined(9) } as never },
            ]),
        );
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();

        expect(await within(region).findByText('Live member 9 joined')).toBeDefined();
        expect(within(region).getAllByRole('listitem')).toHaveLength(1);
        expect(within(region).queryByRole('button', { name: 'Runs' })).toBeNull();
    });

    it('loads older pages on demand', async () => {
        const engine = createHomeEngine({ activity: seededActivity(25) });
        const { user } = renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(20);
        });

        await user.click(within(region).getByRole('button', { name: 'Load older' }));
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(25);
        });
        expect(within(region).queryByRole('button', { name: 'Load older' })).toBeNull();
    });
});

describe('home: older activity', { timeout: TIMEOUT_MS }, () => {
    it('offers a retry when older activity cannot load', async () => {
        const engine = createHomeEngine({ activity: seededActivity(25) });
        const { user } = renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(20);
        });
        engine.spies.activity.mockImplementationOnce(() =>
            Promise.resolve({ kind: 'problem', problem: createProblem('forbidden') }),
        );

        await user.click(within(region).getByRole('button', { name: 'Load older' }));
        expect(await within(region).findByText('Older activity could not load.')).toBeDefined();
        await user.click(within(region).getByRole('button', { name: 'Try again' }));
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(25);
        });
    });
});

describe('home: activity cards', { timeout: TIMEOUT_MS }, () => {
    it('gives an unknown kind, a higher version and an invalid item the generic card with the raw kind as text', async () => {
        const engine = createHomeEngine();
        engine.spies.activity.mockImplementation(() =>
            page([
                {
                    kind: 'unknown',
                    base: { ...base, id: 'a-1', kind: 'deploy.started', v: 1 } as never,
                    raw: { secret: 'payload-1' },
                },
                {
                    kind: 'unknown',
                    base: { ...base, id: 'a-2', kind: 'run.failed', v: 2 } as never,
                    raw: { secret: 'payload-2' },
                },
                {
                    kind: 'unknown',
                    base: { ...base, id: 'a-4', kind: 'constructor.started', v: 1, agentName: null } as never,
                    raw: {},
                },
                {
                    kind: 'invalid',
                    base: { ...base, id: 'a-3', kind: 'member.joined', v: 1 } as never,
                    issues: [{ path: 'displayName', code: 'invalid_type' }],
                },
            ]),
        );
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();

        const cards = await within(region).findAllByRole('listitem');
        expect(cards.map((card) => card.querySelector('code')?.textContent)).toEqual([
            'deploy.started',
            'run.failed',
            'constructor.started',
            'member.joined',
        ]);
        for (const card of cards) {
            expect(card.textContent).toMatch(/Ada|Unnamed agent/);
            expect(card.textContent).not.toContain('payload');
        }
        expect(cards[2]?.textContent).toContain('Unnamed agent');
    });

    it('renders a hostile agent name as text, linking by the agent ID', async () => {
        const engine = createHomeEngine();
        engine.spies.activity.mockImplementation(() =>
            page([
                {
                    kind: 'unknown',
                    base: { ...base, agentName: HOSTILE, kind: 'deploy.started', v: 1 } as never,
                    raw: {},
                },
                {
                    kind: 'known',
                    activity: {
                        ...base,
                        id: 'a-2',
                        agentName: HOSTILE,
                        kind: 'run.started',
                        v: 1,
                        runId: 'run-completed',
                        source: 'web',
                    } as never,
                },
            ]),
        );
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();

        const links = await within(region).findAllByRole('link', { name: HOSTILE });
        expect(links).toHaveLength(2);
        for (const link of links) expect(link.getAttribute('href')).toBe('/agents/agent-ada');
        expect(region.querySelector('img, script')).toBeNull();
        expect(window.__ptbkCspViolations).toEqual([]);
    });

    it('announces the raw kind when a renderer cannot summarise its item', async () => {
        const broken = defineFeature({
            id: 'broken-summary',
            requires: {},
            activityRenderers: [
                {
                    kind: 'member.joined',
                    versions: [1],
                    component: () => null,
                    summary: () => {
                        throw new Error('summary bug');
                    },
                },
            ],
        });
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client, features: [broken, ...FEATURES] });
        await within(await feed()).findAllByRole('listitem');

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
        });
        await waitFor(() => {
            expect(liveRegion()?.textContent).toBe('member.joined');
        });
    });

    it('keeps a feed alive when a renderer throws, showing that item’s generic card', async () => {
        const broken = defineFeature({
            id: 'broken',
            requires: {},
            activityRenderers: [
                {
                    kind: 'member.joined',
                    versions: [1],
                    component: () => {
                        throw new Error('renderer bug');
                    },
                    summary: () => 'never',
                },
            ],
        });
        const engine = createHomeEngine({ activity: seededActivity(5) });
        renderWithProviders({ path: '/', engineApi: engine.client, features: [...FEATURES, broken] });
        const region = await feed();

        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(5);
        });
        expect(within(region).getByText('member.joined')).toBeDefined();
    });
});
