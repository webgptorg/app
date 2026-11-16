import type { ActivityItem, IntegrationId } from '@ptbk/engine-api';
import { EmptyState, ErrorState, RelativeTime, Section, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { findActivityRenderer } from '../../app/registry/activity-renderers';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { integrationActivityQueryOptions } from './integrations-queries';

const SKELETON_ROWS = 3;

function keyOf(item: ActivityItem): string {
    return item.kind === 'known' ? item.activity.id : item.base.id;
}

/**
 * A known kind through the renderer a feature registered, anything else (unknown, invalid) as one generic line; as a
 * hairline row with when it happened at the end in tabular figures, as the shared tables draw theirs.
 */
function ActivityEntry({ item }: { readonly item: ActivityItem }) {
    const features = useVisibleFeatures();
    const base = item.kind === 'known' ? item.activity : item.base;
    const renderer = item.kind === 'known' ? findActivityRenderer(features, base.kind, base.v) : undefined;
    return (
        <li className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 py-2 sm:items-center">
            {renderer !== undefined && item.kind === 'known' ? (
                <renderer.component activity={item.activity} />
            ) : (
                <p className="text-sm break-words text-text-muted">
                    {m.integration_activity_generic({ kind: base.kind })}
                </p>
            )}
            <RelativeTime
                value={new Date(base.at)}
                className="flex h-6 items-center text-xs whitespace-nowrap text-text-muted tabular-nums"
            />
        </li>
    );
}

/** The integration's latest activity (`GET /activity?integrationId`), kept current by the event stream. */
export function IntegrationActivityList({
    integrationId,
    lastActivityAt,
}: {
    readonly integrationId: IntegrationId;
    /** When the engine last saw it used; the feed may hold nothing that recent, so the empty copy must not say "never". */
    readonly lastActivityAt: string | null;
}) {
    const activity = useQuery(integrationActivityQueryOptions(useEngineApi(), integrationId));
    let body: ReactNode;
    if (activity.isPending) {
        body = (
            <ul aria-busy="true" aria-label={m.integration_activity_title()} className="flex flex-col gap-2">
                {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                    <li key={index}>
                        <Skeleton shape="text" className="h-6 w-full" />
                    </li>
                ))}
            </ul>
        );
    } else if (activity.isError) {
        body = (
            <ErrorState
                message={m.integration_activity_load_failed()}
                onRetry={() => {
                    void activity.refetch();
                }}
                retrying={activity.isFetching}
            />
        );
    } else if (activity.data.items.length === 0) {
        body = (
            <EmptyState
                variant="inline"
                headingLevel={3}
                icon={<History aria-hidden />}
                title={lastActivityAt === null ? m.integration_activity_none() : m.integration_activity_none_recent()}
            />
        );
    } else {
        body = (
            <ul aria-label={m.integration_activity_title()} className="flex flex-col divide-y divide-hairline">
                {activity.data.items.map((item) => (
                    <ActivityEntry key={keyOf(item)} item={item} />
                ))}
            </ul>
        );
    }
    return <Section title={m.integration_activity_title()}>{body}</Section>;
}
