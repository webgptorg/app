import type { AgentId } from '@ptbk/engine-api';
import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { Skeleton } from '@ptbk/ui';
import { CalendarClock } from 'lucide-react';
import { lazy, Suspense } from 'react';

import { AGENT_TABS, defineFeature } from '../../app/registry/feature';
import type { Attention } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { TriggerActivityItem, triggerActivitySummary } from './trigger-activity';
import { useTriggerStats } from './triggers-queries';
import { useTriggerEventSync } from './use-trigger-event-sync';

const LazyTriggerOverviewCard = lazy(() =>
    import('./trigger-overview-card').then((module) => ({ default: module.TriggerOverviewCard })),
);

/** The card's code loads with the agent page that shows it, not with the app. */
function TriggerOverviewCard({ agentId }: { readonly agentId: AgentId }) {
    return (
        <Suspense fallback={<Skeleton shape="block" className="h-40 w-full" />}>
            <LazyTriggerOverviewCard agentId={agentId} />
        </Suspense>
    );
}

function useFailedTriggersAttention(): Attention {
    const stats = useTriggerStats();
    return {
        count: stats.data?.failed ?? 0,
        to: '/triggers',
        search: { lifecycle: 'failed' },
        pending: stats.data === undefined,
    };
}

/**
 * Triggers (`triggers@1`): what starts agents without a chat, inbound email addresses and schedules, with pause and
 * resume one tap away (U-11). Webhooks are a draft in the contract and show only as "coming later".
 */
export const triggersFeature = defineFeature({
    id: 'triggers',
    requires: { capability: KNOWN_CAPABILITIES.triggers, permission: 'triggers.read' },
    nav: { group: 'resources', order: 20, label: m.nav_triggers, icon: CalendarClock, to: '/triggers' },
    agentTabs: [{ ...AGENT_TABS.triggers, label: m.agent_tab_triggers, to: '/agents/$agentId/triggers' }],
    agentOverviewCards: [{ id: 'triggers.summary', order: 30, component: TriggerOverviewCard }],
    activityRenderers: [
        { kind: 'trigger.*', versions: [1], component: TriggerActivityItem, summary: triggerActivitySummary },
    ],
    attention: {
        id: 'triggers.failed',
        useAttention: useFailedTriggersAttention,
        label: (count) => m.triggers_attention_failed({ count }),
        tone: 'danger',
    },
    eventSync: { useEventSync: useTriggerEventSync },
    commands: [
        { id: 'triggers.open', label: m.command_go_to_triggers, keywords: () => [m.nav_triggers()], to: '/triggers' },
        {
            id: 'triggers.new-schedule',
            label: m.command_new_schedule,
            keywords: () => [m.nav_triggers(), m.trigger_kind_schedule()],
            to: '/triggers/new',
            requires: { permission: 'triggers.manage' },
        },
        {
            id: 'triggers.pause',
            label: m.command_pause_trigger,
            keywords: () => [m.nav_triggers(), m.trigger_pause()],
            to: '/triggers',
            search: { lifecycle: 'active' },
            requires: { permission: 'triggers.manage' },
        },
        {
            id: 'triggers.resume',
            label: m.command_resume_trigger,
            keywords: () => [m.nav_triggers(), m.trigger_resume()],
            to: '/triggers',
            search: { lifecycle: 'paused' },
            requires: { permission: 'triggers.manage' },
        },
    ],
});
