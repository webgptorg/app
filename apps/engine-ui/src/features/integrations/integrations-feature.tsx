import type { AgentId } from '@ptbk/engine-api';
import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { Skeleton } from '@ptbk/ui';
import { Plug } from 'lucide-react';
import { lazy, Suspense } from 'react';

import { AGENT_TABS, defineFeature } from '../../app/registry/feature';
import type { Attention } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { IntegrationActivityItem, integrationActivitySummary } from './integration-activity';
import { useIntegrationStats } from './integrations-queries';
import { useIntegrationEventSync } from './use-integration-event-sync';

const LazyIntegrationsCard = lazy(() =>
    import('./integrations-card').then((module) => ({ default: module.IntegrationsCard })),
);

/** The card's code loads with the agent page that shows it, not with the app. */
function IntegrationsOverviewCard({ agentId }: { readonly agentId: AgentId }) {
    return (
        <Suspense fallback={<Skeleton shape="block" className="h-40 w-full" />}>
            <LazyIntegrationsCard agentId={agentId} />
        </Suspense>
    );
}

function useIntegrationAttention(): Attention {
    const stats = useIntegrationStats().data;
    return {
        count: (stats?.needsAttention ?? 0) + (stats?.error ?? 0),
        to: '/integrations',
        search: { status: 'needs-attention,error' },
        pending: stats === undefined,
    };
}

/**
 * Integrations (`integrations@1`): the MCP servers, calendars and repositories agents may reach outside the engine,
 * with their status, scopes, tools and the secrets they reference by name (U-12).
 */
export const integrationsFeature = defineFeature({
    id: 'integrations',
    requires: { capability: KNOWN_CAPABILITIES.integrations, permission: 'integrations.read' },
    nav: { group: 'resources', order: 30, label: m.nav_integrations, icon: Plug, to: '/integrations' },
    agentTabs: [{ ...AGENT_TABS.integrations, label: m.agent_tab_integrations, to: '/agents/$agentId/integrations' }],
    agentOverviewCards: [{ id: 'integrations.status', order: 40, component: IntegrationsOverviewCard }],
    activityRenderers: [
        {
            kind: 'integration.*',
            versions: [1],
            component: IntegrationActivityItem,
            summary: integrationActivitySummary,
        },
    ],
    attention: {
        id: 'integrations.attention',
        useAttention: useIntegrationAttention,
        label: (count) => m.integrations_attention({ count }),
    },
    eventSync: { useEventSync: useIntegrationEventSync },
    commands: [
        {
            id: 'integrations.open',
            label: m.command_go_to_integrations,
            keywords: () => [m.nav_integrations()],
            to: '/integrations',
        },
        {
            id: 'integrations.add-mcp',
            label: m.command_add_mcp_server,
            keywords: () => [m.nav_integrations(), 'MCP'],
            to: '/integrations',
            requires: { permission: 'integrations.manage' },
        },
        {
            id: 'integrations.disable',
            label: m.command_disable_integration,
            keywords: () => [m.nav_integrations(), m.integration_disable()],
            to: '/integrations',
            requires: { permission: 'integrations.manage' },
        },
    ],
});
