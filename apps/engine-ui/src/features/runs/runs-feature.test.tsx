import { KNOWN_CAPABILITIES, PERMISSIONS, RunId, Timestamp } from '@ptbk/engine-api';
import type { Activity, AgentId, Permission } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FEATURES } from '../../app/features';
import { defineFeature } from '../../app/registry/feature';
import { visibleFeatures } from '../../app/registry/visibility';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createRunsEngine, RUN_IDS } from '../../testing/runs-engine';
import { TEST_NOW } from '../../testing/test-engine-api';
import { diffLineKind } from './diff-view';
import { agentStateFromStats } from './run-agent-state';
import { runListParams, RunSearch } from './run-search';
import { runsFeature } from './runs-feature';

const TIMEOUT_MS = 20_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));
const ALL_CAPABILITIES = Object.values(KNOWN_CAPABILITIES);
const access = (permissions: readonly Permission[], capabilities = ALL_CAPABILITIES) => ({
    can: (permission: Permission) => permissions.includes(permission),
    supports: (capability: { readonly id: string; readonly version: number }) =>
        capabilities.some(({ id, version }) => id === capability.id && version === capability.version),
});

describe('agent state from runs', () => {
    const stats = { running: 0, queued: 0, failedLast24h: 0, oldestQueuedAt: null, lastFinished: null };
    const at = Timestamp.parse(TEST_NOW.toISOString());

    it('is working, waiting, failed or idle, in that order of precedence', () => {
        expect(agentStateFromStats({ ...stats, running: 1, queued: 2, failedLast24h: 1 })).toBe('working');
        expect(agentStateFromStats({ ...stats, queued: 2, failedLast24h: 1 })).toBe('waiting');
        expect(agentStateFromStats({ ...stats, failedLast24h: 1, lastFinished: { status: 'failed', at } })).toBe(
            'failed',
        );
        expect(agentStateFromStats(stats)).toBe('idle');
    });

    it('is idle once a later run finished after a recent failure', () => {
        expect(agentStateFromStats({ ...stats, failedLast24h: 1, lastFinished: { status: 'completed', at } })).toBe(
            'idle',
        );
    });
});

describe('agent status provider', { timeout: TIMEOUT_MS }, () => {
    const rowOf = async (name: string) => (await screen.findByRole('link', { name })).closest('tr') as HTMLElement;

    it('derives each agent’s badge from its run counts and follows run.changed events', async () => {
        const engine = createRunsEngine();
        renderWithProviders({ path: '/agents?view=table', engineApi: engine.client });
        expect(await within(await rowOf('Ada')).findByText('Working')).toBeDefined();
        expect(await within(await rowOf('Grace')).findByText('Waiting')).toBeDefined();
        expect(await within(await rowOf('Iris')).findByText('Failed')).toBeDefined();
        expect(await within(await rowOf('Max')).findByText('Idle')).toBeDefined();

        act(() => {
            engine.controller.advanceRun(RUN_IDS.queued);
        });
        expect(await within(await rowOf('Grace')).findByText('Working')).toBeDefined();
        act(() => {
            engine.controller.advanceRun(RUN_IDS.queued);
        });
        expect(await within(await rowOf('Grace')).findByText('Idle')).toBeDefined();
    });

    it('shows the number of running runs in the shell’s live indicator', async () => {
        const engine = createRunsEngine();
        renderWithProviders({ path: '/settings', engineApi: engine.client });
        expect(await screen.findByText('1 running now')).toBeDefined();
        act(() => {
            engine.controller.advanceRun(RUN_IDS.running);
        });
        await waitFor(() => {
            expect(screen.queryByText('1 running now')).toBeNull();
        });
    });
});

describe('recent runs overview card', { timeout: TIMEOUT_MS }, () => {
    it('shows the agent’s last five runs with a link to all of them', async () => {
        renderWithProviders({ path: '/agents/agent-max', engineApi: createRunsEngine().client });
        const card = await screen.findByRole('region', { name: 'Recent runs' });
        expect(await within(card).findByText('Import the data set')).toBeDefined();
        expect(within(card).getAllByRole('listitem')).toHaveLength(5);
        expect(within(card).getByRole('link', { name: 'All runs' }).getAttribute('href')).toBe(
            '/agents/agent-max/runs',
        );
    });

    it('is absent without runs.read or runs@1', async () => {
        const withoutRead = createRunsEngine({ permissions: allBut('runs.read', 'runs.control') });
        renderWithProviders({ path: '/agents/agent-max', engineApi: withoutRead.client });
        await screen.findByRole('region', { name: 'Details' });
        expect(screen.queryByRole('region', { name: 'Recent runs' })).toBeNull();
        expect(screen.queryByRole('tab', { name: 'Runs' })).toBeNull();

        const withoutCapability = createRunsEngine({
            capabilities: Object.values(KNOWN_CAPABILITIES).filter(({ id }) => id !== 'runs'),
        });
        renderWithProviders({ path: '/agents/agent-max', engineApi: withoutCapability.client });
        await screen.findAllByRole('region', { name: 'Details' });
        expect(screen.queryByRole('region', { name: 'Recent runs' })).toBeNull();
        expect(withoutCapability.spies.list).not.toHaveBeenCalled();
        expect(withoutCapability.spies.stats).not.toHaveBeenCalled();
    });
});

describe('registry gating', () => {
    it('shows nav, tab, card, attention, palette search and status only with runs@1 and runs.read', () => {
        const full = visibleFeatures(FEATURES, access(PERMISSIONS)).find(({ id }) => id === 'runs');
        expect(full?.nav?.to).toBe('/runs');
        expect(full?.agentTabs?.map(({ id }) => id)).toEqual(['runs']);
        expect(full?.agentOverviewCards?.map(({ id }) => id)).toEqual(['runs.recent']);
        expect(full?.paletteSearch?.id).toBe('runs');
        expect(full?.attention?.id).toBe('runs.failed');
        expect(full?.agentStatusProvider).toBeDefined();

        expect(visibleFeatures(FEATURES, access(allBut('runs.read'))).some(({ id }) => id === 'runs')).toBe(false);
        const withoutRuns = ALL_CAPABILITIES.filter(({ id }) => id !== 'runs');
        expect(visibleFeatures(FEATURES, access(PERMISSIONS, withoutRuns)).some(({ id }) => id === 'runs')).toBe(false);
    });
});

describe('run activity renderers', { timeout: TIMEOUT_MS }, () => {
    const base = {
        v: 1,
        at: TEST_NOW.toISOString(),
        agentId: 'agent-ada' as AgentId,
        actor: { kind: 'system' },
        runId: RunId.parse(RUN_IDS.completed),
        source: 'email',
    } as const;
    const ACTIVITIES = [
        { ...base, id: 'a1', kind: 'run.queued' },
        { ...base, id: 'a2', kind: 'run.started' },
        {
            ...base,
            id: 'a3',
            kind: 'run.completed',
            usage: {
                inputTokens: 1,
                outputTokens: 1,
                durationMs: 65_000,
                cost: { amount: '0.0042', currency: 'USD' },
            },
        },
        { ...base, id: 'a4', kind: 'run.failed', error: { code: 'rate-limit', summary: 'Too many requests' } },
        { ...base, id: 'a5', kind: 'run.cancelled' },
    ] as unknown as readonly Activity[];

    it('renders every v1 run kind with its payload and a link to the run', async () => {
        const [renderer] = runsFeature.activityRenderers;
        expect(renderer.kind).toBe('run.*');
        expect(renderer.versions).toEqual([1]);
        const feed = defineFeature({
            id: 'feed',
            requires: {},
            agentOverviewCards: [
                {
                    id: 'feed',
                    order: 0,
                    component: () => (
                        <ul aria-label="Feed">
                            {ACTIVITIES.map((activity) => (
                                <li key={activity.id}>
                                    <renderer.component activity={activity} />
                                </li>
                            ))}
                        </ul>
                    ),
                },
            ],
        });
        renderWithProviders({
            path: '/agents/agent-ada',
            engineApi: createRunsEngine().client,
            features: [...FEATURES, feed],
        });
        const list = await screen.findByRole('list', { name: 'Feed' });
        // One table-like line each: the run as a chip, its outcome in words, what it took or why it failed.
        for (const outcome of ['Queued', 'Running', 'Completed', 'Failed', 'Stopped']) {
            expect(within(list).getByText(outcome)).toBeDefined();
        }
        expect(within(list).getByText('1 min 5 s · $0.0042')).toBeDefined();
        expect(within(list).getByText('Too many requests')).toBeDefined();
        const links = within(list).getAllByRole('link', { name: 'Email run' });
        expect(links).toHaveLength(5);
        for (const link of links) expect(link.getAttribute('href')).toBe(`/runs/${RUN_IDS.completed}`);
        expect(ACTIVITIES.map((activity) => renderer.summary(activity))).toEqual([
            'A run from an email was queued',
            'A run from an email started',
            'A run from an email completed',
            'A run from an email failed',
            'A run from an email was stopped',
        ]);
    });
});

describe('run search params', () => {
    it('keeps a canonical status set and drops what it does not know', () => {
        expect(RunSearch.parse({ status: 'failed,queued,failed' }).status).toBe('queued,failed');
        expect(RunSearch.parse({ status: 'failed,paused' }).status).toBeUndefined();
        expect(RunSearch.parse({ status: '' }).status).toBeUndefined();
        expect(RunSearch.parse({ source: 'kiosk', from: 'yesterday', cursor: '==' })).toEqual({});
    });

    it('sends whole local days to the engine and scopes an agent tab by its path', () => {
        const params = runListParams(
            RunSearch.parse({ from: '2026-10-01', to: '2026-10-02', agentId: 'agent-max' }),
            'agent-ada' as AgentId,
        );
        expect(params).toEqual({
            limit: 50,
            agentId: 'agent-ada',
            from: new Date(2026, 9, 1).toISOString(),
            to: new Date(2026, 9, 3).toISOString(),
        });
    });
});

describe('diff lines', () => {
    it('are classified by their first characters only', () => {
        expect(diffLineKind('+added')).toBe('added');
        expect(diffLineKind('-removed')).toBe('removed');
        expect(diffLineKind('@@ -1 +1 @@')).toBe('hunk');
        expect(diffLineKind('+++ b/file')).toBe('meta');
        expect(diffLineKind('--- a/file')).toBe('meta');
        expect(diffLineKind('diff --git a/x b/x')).toBe('meta');
        expect(diffLineKind('\\ No newline at end of file')).toBe('meta');
        expect(diffLineKind(' context')).toBe('context');
        expect(diffLineKind('<script>alert(1)</script>')).toBe('context');
    });
});
