import type { AgentId } from '@ptbk/engine-api';
import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { Skeleton } from '@ptbk/ui';
import { Activity as ActivityIcon } from 'lucide-react';
import { lazy, Suspense } from 'react';

import { AGENT_TABS, defineFeature } from '../../app/registry/feature';
import type { Attention } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { RunActivityItem, runActivitySummary } from './run-activity';
import { useRunAgentLiveState } from './run-agent-state';
import { useRunStats } from './runs-queries';
import { useRunEventSync } from './use-run-event-sync';

const LazyRecentRunsCard = lazy(() =>
    import('./recent-runs-card').then((module) => ({ default: module.RecentRunsCard })),
);

/** The card's code loads with the agent page that shows it, not with the app. */
function RecentRunsOverviewCard({ agentId }: { readonly agentId: AgentId }) {
    return (
        <Suspense fallback={<Skeleton shape="block" className="h-56 w-full" />}>
            <LazyRecentRunsCard agentId={agentId} />
        </Suspense>
    );
}

function useRunningCount(): number {
    return useRunStats().data?.running ?? 0;
}

function useFailedRunsAttention(): Attention {
    const stats = useRunStats();
    return { count: stats.data?.failedLast24h ?? 0, to: '/runs', search: { status: 'failed' } };
}

/**
 * Runs (`runs@1`): every unit of agent work, across agents and per agent, with cancel and retry (U-09). It also tells
 * the rest of the app what agents are doing: their live state, the shell's live indicator and the home's attention.
 */
export const runsFeature = defineFeature({
    id: 'runs',
    requires: { capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' },
    nav: { group: 'work', order: 40, label: m.nav_runs, icon: ActivityIcon, to: '/runs' },
    agentTabs: [{ ...AGENT_TABS.runs, label: m.agent_tab_runs, to: '/agents/$agentId/runs' }],
    agentOverviewCards: [{ id: 'runs.recent', order: 10, component: RecentRunsOverviewCard }],
    activityRenderers: [{ kind: 'run.*', versions: [1], component: RunActivityItem, summary: runActivitySummary }],
    attention: { id: 'runs.failed', useAttention: useFailedRunsAttention },
    liveIndicator: { useActiveCount: useRunningCount },
    agentStatusProvider: { useAgentLiveState: useRunAgentLiveState },
    eventSync: { useEventSync: useRunEventSync },
    commands: [
        { id: 'runs.open', label: m.command_go_to_run, keywords: () => [m.nav_runs()], to: '/runs' },
        {
            id: 'runs.stop',
            label: m.command_stop_run,
            keywords: () => [m.nav_runs(), m.run_cancel()],
            to: '/runs',
            requires: { permission: 'runs.control' },
        },
    ],
});
