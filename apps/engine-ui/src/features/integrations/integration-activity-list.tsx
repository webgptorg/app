import type { ActivityItem, IntegrationId } from '@ptbk/engine-api';
import { Card, ErrorState, RelativeTime, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { findActivityRenderer } from '../../app/registry/activity-renderers';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { integrationActivityQueryOptions } from './integrations-queries';

const SKELETON_ROWS = 3;

function keyOf(item: ActivityItem): string {
    return item.kind === 'known' ? item.activity.id : item.base.id;
}

/** A known kind through the renderer a feature registered; anything else (unknown, invalid) as a generic card. */
function ActivityEntry({ item }: { readonly item: ActivityItem }) {
    const features = useVisibleFeatures();
    const base = item.kind === 'known' ? item.activity : item.base;
    const renderer = item.kind === 'known' ? findActivityRenderer(features, base.kind, base.v) : undefined;
    return (
        <li className="flex flex-col gap-1 py-2">
            <RelativeTime value={new Date(base.at)} className="text-xs text-text-muted" />
            {renderer !== undefined && item.kind === 'known' ? (
                <renderer.component activity={item.activity} />
            ) : (
                <p className="text-sm break-words">{m.integration_activity_generic({ kind: base.kind })}</p>
            )}
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
    return (
        <Card title={m.integration_activity_title()} titleLevel={2}>
            {activity.isPending ? (
                <ul aria-busy="true" aria-label={m.integration_activity_title()} className="flex flex-col gap-2">
                    {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                        <li key={index}>
                            <Skeleton shape="text" className="h-6 w-full" />
                        </li>
                    ))}
                </ul>
            ) : activity.isError ? (
                <ErrorState
                    message={m.integration_activity_load_failed()}
                    onRetry={() => {
                        void activity.refetch();
                    }}
                    retrying={activity.isFetching}
                />
            ) : activity.data.items.length === 0 ? (
                <p className="text-sm text-text-muted">
                    {lastActivityAt === null ? m.integration_activity_none() : m.integration_activity_none_recent()}
                </p>
            ) : (
                <ul aria-label={m.integration_activity_title()} className="flex flex-col divide-y divide-divider">
                    {activity.data.items.map((item) => (
                        <ActivityEntry key={keyOf(item)} item={item} />
                    ))}
                </ul>
            )}
        </Card>
    );
}
