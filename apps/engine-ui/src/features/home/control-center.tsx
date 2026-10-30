import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { RunStats } from '@ptbk/engine-api';
import { Banner, Card, ErrorState, Skeleton, useLocale } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import type { Attention, FeatureDefinition } from '../../app/registry/feature';
import { useAllows, useVisibleFeatures } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { runStatsQueryOptions } from '../runs/runs-queries';
import { securityOverviewQueryOptions } from '../security/security-queries';
import { ActivityFeed } from './activity/activity-feed';
import { AgentListWidget } from './agent-list-widget';
import { recentAgentsQueryOptions, RECENT_AGENTS, updateNoticeQueryOptions } from './home-queries';

/** For members who oversee the engine: what runs, what needs a look, recent agents, updates and everything live. */
export function ControlCenter() {
    // The feed (`GET /activity`) needs `agents.read` too: activity is about agents.
    const agentsVisible = useAllows({ permission: 'agents.read' });
    return (
        <>
            <UpdateBanner />
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-6">
                    <Counts />
                    {agentsVisible ? <RecentAgents /> : null}
                </div>
                {agentsVisible ? <ActivityFeed /> : null}
            </div>
        </>
    );
}

function RecentAgents() {
    return (
        <AgentListWidget
            title={m.home_recent_agents()}
            query={useQuery(recentAgentsQueryOptions(useEngineApi()))}
            skeletonRows={RECENT_AGENTS}
        />
    );
}

/**
 * `GET /security` says an update is available, or the event stream just announced one. Shown until the engine
 * reports it installed; the security panel has the details and the controls.
 */
function UpdateBanner() {
    const engineApi = useEngineApi();
    const locale = useLocale();
    const security = useQuery(securityOverviewQueryOptions(engineApi)).data;
    const notice = useQuery(updateNoticeQueryOptions()).data ?? null;
    const fromPanel = security?.update.status === 'available' ? security.update : undefined;
    if (fromPanel === undefined && notice === null) return null;
    const version = fromPanel?.availableVersion ?? notice?.version ?? null;
    const eligibleAt = fromPanel?.eligibleAt ?? null;
    return (
        <Banner
            tone="info"
            title={m.home_update_title()}
            action={
                <Link to="/settings" className="text-sm font-medium">
                    {m.home_update_open()}
                </Link>
            }
        >
            {version === null
                ? m.home_update_body()
                : eligibleAt === null
                  ? m.home_update_version({ version })
                  : m.home_update_version_at({ version, at: locale.formatDateTime(new Date(eligibleAt)) })}
        </Banner>
    );
}

/**
 * Run counts with `runs@1` and `runs.read` (absent without, never a zero), and every attention provider's count. When
 * all of them are known to be zero, one quiet line replaces the tiles.
 */
function Counts() {
    const runsVisible = useAllows({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' });
    const sources = useVisibleFeatures().flatMap((feature) =>
        feature.attention === undefined ? [] : [{ feature, entry: feature.attention }],
    );
    const stats = useQuery({ ...runStatsQueryOptions(useEngineApi()), enabled: runsVisible });
    const [reported, setReported] = useState<ReadonlyMap<string, Attention>>(new Map());
    const [onAttention] = useState(() => (id: string, attention: Attention) => {
        setReported((previous) => {
            const known = previous.get(id);
            return known?.count === attention.count && known.pending === attention.pending
                ? previous
                : new Map(previous).set(id, attention);
        });
    });
    if (!runsVisible && sources.length === 0) return null;
    const runsQuiet = !runsVisible || (stats.data?.running === 0 && stats.data.queued === 0);
    const attentionQuiet = sources.every(({ entry }) => {
        const attention = reported.get(entry.id);
        return attention !== undefined && attention.pending !== true && attention.count === 0;
    });
    return (
        <Card title={m.home_counts_title()} className="min-w-0">
            {sources.map(({ entry }) => (
                <AttentionProbe key={entry.id} entry={entry} onAttention={onAttention} />
            ))}
            {runsQuiet && attentionQuiet ? (
                <p className="flex items-center gap-2 text-text-muted">
                    <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
                    {runsVisible ? m.home_all_quiet() : m.home_nothing_needs_attention()}
                </p>
            ) : (
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    {runsVisible ? <RunCounts stats={stats} /> : null}
                    {sources.length > 0 ? <AttentionCount sources={sources} reported={reported} /> : null}
                </dl>
            )}
        </Card>
    );
}

function Stat({
    label,
    value,
    children,
    className,
    busy = false,
}: {
    readonly label: string;
    readonly value: ReactNode;
    readonly busy?: boolean;
    readonly children?: ReactNode;
    readonly className?: string;
}) {
    return (
        <div className={cx('flex flex-col gap-1', className)}>
            <dt className="text-sm text-text-muted">{label}</dt>
            <dd className="flex flex-col gap-2" aria-busy={busy || undefined}>
                <span className="font-display text-3xl font-semibold tabular-nums">{value}</span>
                {children}
            </dd>
        </div>
    );
}

function RunCounts({ stats }: { readonly stats: UseQueryResult<RunStats> }) {
    const locale = useLocale();
    if (stats.isError && stats.data === undefined) {
        return (
            <div className="col-span-2">
                <ErrorState
                    message={m.home_widget_failed()}
                    onRetry={() => {
                        void stats.refetch();
                    }}
                    retrying={stats.isFetching}
                />
            </div>
        );
    }
    const value = (count: number | undefined) =>
        count === undefined ? <Skeleton className="h-9 w-12" /> : locale.formatNumber(count);
    return (
        <>
            <Stat label={m.home_running_now()} value={value(stats.data?.running)} busy={stats.data === undefined} />
            <Stat label={m.home_queued()} value={value(stats.data?.queued)} busy={stats.data === undefined} />
        </>
    );
}

type AttentionEntry = NonNullable<FeatureDefinition['attention']>;

interface AttentionSource {
    readonly feature: FeatureDefinition;
    readonly entry: AttentionEntry;
}

/** Calls one provider's hook; one component per provider keeps the rules of hooks with any number of them. */
function AttentionProbe({
    entry,
    onAttention,
}: {
    readonly entry: AttentionEntry;
    readonly onAttention: (id: string, attention: Attention) => void;
}) {
    const attention = entry.useAttention();
    useEffect(() => {
        onAttention(entry.id, attention);
    }, [entry.id, attention, onAttention]);
    return null;
}

/** The sum of every registered provider, each linking to the view that shows exactly what it counts. */
function AttentionCount({
    sources,
    reported,
}: {
    readonly sources: readonly AttentionSource[];
    readonly reported: ReadonlyMap<string, Attention>;
}) {
    const locale = useLocale();
    const total = sources.reduce((sum, { entry }) => sum + (reported.get(entry.id)?.count ?? 0), 0);
    return (
        <Stat label={m.home_needs_attention()} value={locale.formatNumber(total)} className="col-span-2 sm:col-span-1">
            <ul className="flex flex-col gap-1 text-sm">
                {sources.map(({ feature, entry }) => {
                    const attention = reported.get(entry.id);
                    if (attention === undefined || attention.count === 0) return null;
                    const label =
                        entry.label?.(attention.count) ??
                        `${feature.nav?.label() ?? feature.id}: ${locale.formatNumber(attention.count)}`;
                    return (
                        <li key={entry.id}>
                            <Link to={attention.to} search={attention.search ?? {}}>
                                {label}
                            </Link>
                        </li>
                    );
                })}
            </ul>
        </Stat>
    );
}
