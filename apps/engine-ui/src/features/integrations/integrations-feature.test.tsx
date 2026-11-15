import { IntegrationId, KNOWN_CAPABILITIES, PERMISSIONS, RunId } from '@ptbk/engine-api';
import type { Activity, Permission } from '@ptbk/engine-api';
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { EngineApiProvider } from '../../app/engine-api-context';
import { FEATURES } from '../../app/features';
import { createAppQueryClient } from '../../app/query-client';
import { defineFeature } from '../../app/registry/feature';
import { visibleFeatures } from '../../app/registry/visibility';
import { createIntegrationsEngine, INTEGRATION_IDS } from '../../testing/integrations-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';
import { integrationsFeature } from './integrations-feature';

const TIMEOUT_MS = 20_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));
const ALL_CAPABILITIES = Object.values(KNOWN_CAPABILITIES);
const access = (permissions: readonly Permission[], capabilities = ALL_CAPABILITIES) => ({
    can: (permission: Permission) => permissions.includes(permission),
    supports: (capability: { readonly id: string; readonly version: number }) =>
        capabilities.some(({ id, version }) => id === capability.id && version === capability.version),
});

describe('registry gating', () => {
    it('shows nav, tab, card, attention and commands only with integrations@1 and integrations.read', () => {
        const full = visibleFeatures(FEATURES, access(PERMISSIONS)).find(({ id }) => id === 'integrations');
        expect(full?.nav).toMatchObject({ group: 'resources', to: '/integrations' });
        expect(full?.agentTabs?.map(({ id, to }) => [id, to])).toEqual([
            ['integrations', '/agents/$agentId/integrations'],
        ]);
        expect(full?.agentOverviewCards?.map(({ id }) => id)).toEqual(['integrations.status']);
        expect(full?.commands?.map(({ id }) => id)).toEqual([
            'integrations.open',
            'integrations.add-mcp',
            'integrations.disable',
        ]);
        expect(full?.attention?.id).toBe('integrations.attention');

        const without = (id: string) => ALL_CAPABILITIES.filter((capability) => capability.id !== id);
        expect(
            visibleFeatures(FEATURES, access(PERMISSIONS, without('integrations'))).map(({ id }) => id),
        ).not.toContain('integrations');
        expect(visibleFeatures(FEATURES, access(allBut('integrations.read'))).map(({ id }) => id)).not.toContain(
            'integrations',
        );
    });

    it('offers "Add MCP server" and "Disable integration" only with integrations.manage', () => {
        const readOnly = visibleFeatures(FEATURES, access(allBut('integrations.manage'))).find(
            ({ id }) => id === 'integrations',
        );
        expect(readOnly?.commands?.map(({ id }) => id)).toEqual(['integrations.open']);
    });
});

describe('attention', { timeout: TIMEOUT_MS }, () => {
    it('counts what needs attention or failed and links to exactly those', async () => {
        const engine = createIntegrationsEngine();
        const queryClient = createAppQueryClient({ onUnauthenticated: () => undefined });
        const wrapper = ({ children }: { readonly children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>
                <EngineApiProvider client={engine.client}>{children}</EngineApiProvider>
            </QueryClientProvider>
        );
        const { result } = renderHook(() => integrationsFeature.attention.useAttention(), { wrapper });
        await waitFor(() => {
            expect(result.current.count).toBe(2);
        });
        expect(result.current).toEqual({
            count: 2,
            to: '/integrations',
            search: { status: 'needs-attention,error' },
            pending: false,
        });
    });
});

describe('overview card', { timeout: TIMEOUT_MS }, () => {
    it('lists what the agent may use, calls out what needs attention first, and links to its tab', async () => {
        const engine = createIntegrationsEngine();
        renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client });
        // The card's code is a lazy chunk.
        const card = await screen.findByRole('region', { name: 'Integrations' }, { timeout: 10_000 });
        expect(await within(card).findByText('2 integrations need attention')).toBeDefined();
        const names = within(card)
            .getAllByRole('listitem')
            .map((item) => within(item).getByRole('link').textContent);
        expect(names).toEqual(['Billing repository', 'Ada’s calendar', 'Docs search']);
        expect(within(card).getByText('Error')).toBeDefined();
        expect(within(card).getByRole('link', { name: 'All integrations' }).getAttribute('href')).toBe(
            '/agents/agent-ada/integrations',
        );
        expect(screen.getByRole('tab', { name: 'Integrations' })).toBeDefined();
    });
});

describe('live updates', { timeout: TIMEOUT_MS }, () => {
    it('refreshes the list on integration.changed and integration activity, without polling', async () => {
        const engine = createIntegrationsEngine();
        renderWithProviders({ path: '/integrations', engineApi: engine.client });
        const table = await screen.findByRole('table');
        await within(table).findByText('Docs search');
        act(() => {
            engine.controller.setIntegrationStatus(INTEGRATION_IDS.off, { status: 'error', statusDetail: 'Gone.' });
        });
        await waitFor(() => {
            const row = within(table).getByText('Review bot').closest('tr') as HTMLElement;
            expect(within(row).getByText('Error')).toBeDefined();
        });
        const calls = engine.spies.list.mock.calls.length;
        act(() => {
            engine.controller.appendActivity({
                kind: 'integration.used',
                agentId: 'agent-ada',
                actor: { kind: 'system' },
                integrationId: INTEGRATION_IDS.billing,
                name: 'Billing repository',
                toolName: 'get_file',
                runId: null,
            });
        });
        await waitFor(() => {
            expect(engine.spies.list.mock.calls.length).toBeGreaterThan(calls);
        });
    });
});

describe('integration activity renderer', { timeout: TIMEOUT_MS }, () => {
    const base = {
        v: 1,
        at: TEST_NOW.toISOString(),
        agentId: null,
        actor: { kind: 'system' },
        integrationId: IntegrationId.parse(INTEGRATION_IDS.docs),
        name: 'Docs search',
    } as const;
    const ACTIVITIES = [
        { ...base, id: 'a1', kind: 'integration.connected' },
        { ...base, id: 'a2', kind: 'integration.error', statusDetail: 'Token expired.' },
        { ...base, id: 'a3', kind: 'integration.used', toolName: 'search', runId: RunId.parse('run-1') },
    ] as unknown as readonly Activity[];

    it('renders every v1 kind with its payload and links, and summarises each in one line', async () => {
        const [renderer] = integrationsFeature.activityRenderers;
        expect(renderer.kind).toBe('integration.*');
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
            engineApi: createIntegrationsEngine().client,
            features: [...FEATURES, feed],
        });
        const list = await screen.findByRole('list', { name: 'Feed' });
        // One table-like line each: the integration as a chip, the tool and its run, the outcome in words.
        for (const outcome of ['Connected', 'Error', 'Tool used'])
            expect(within(list).getByText(outcome)).toBeDefined();
        expect(within(list).getByText('Token expired.')).toBeDefined();
        expect(within(list).getByText('search')).toBeDefined();
        expect(within(list).getByRole('link', { name: 'Run' }).getAttribute('href')).toBe('/runs/run-1');
        const integrationLinks = within(list).getAllByRole('link', { name: 'Docs search' });
        expect(integrationLinks).toHaveLength(3);
        for (const link of integrationLinks) {
            expect(link.getAttribute('href')).toBe(`/integrations/${INTEGRATION_IDS.docs}`);
        }
        expect(ACTIVITIES.map((activity) => renderer.summary(activity))).toEqual([
            'Docs search connected',
            'Docs search needs attention',
            'Docs search: tool search used',
        ]);
    });
});
