import type { ActivityItem } from '@ptbk/engine-api';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { securityKeys } from '../security/security-keys';
import { ACTIVITY_AREAS } from './activity/activity-areas';
import type { ActivityArea } from './activity/activity-areas';
import { belongsToFeed, prependActivity } from './activity/activity-feed-cache';
import type { FeedData } from './activity/activity-feed-cache';
import { activityKeys } from './activity/activity-keys';
import { homeKeys } from './home-keys';
import type { UpdateNotice } from './home-queries';

function feedArea(queryKey: readonly unknown[]): ActivityArea | null | undefined {
    const area = queryKey[activityKeys.feeds().length];
    if (area === null) return null;
    return ACTIVITY_AREAS.find((known) => known === area);
}

/** Every cached feed the item belongs to gets it on top; feeds not loaded yet fetch it with their first page. */
function addToFeeds(queryClient: QueryClient, item: ActivityItem): void {
    for (const query of queryClient.getQueryCache().findAll({ queryKey: activityKeys.feeds() })) {
        const area = feedArea(query.queryKey);
        if (area === undefined || !belongsToFeed(item, area)) continue;
        queryClient.setQueryData<FeedData>(query.queryKey, (data) => prependActivity(data, item));
    }
}

/**
 * Keeps the home's feed and update banner current from the shared event stream for as long as the shell is mounted, so
 * returning to home shows what happened meanwhile without a refetch. After a gap in the stream the feed is refetched,
 * since events in the gap may be lost.
 */
export function useHomeEventSync(): void {
    const queryClient = useQueryClient();
    useEngineEvents({
        onEvent: (event) => {
            if (event.type !== 'activity') return;
            const item = event.activity;
            addToFeeds(queryClient, item);
            if (item.kind !== 'known') return;
            const { activity } = item;
            if (activity.kind === 'engine.update-available' || activity.kind === 'engine.updated') {
                const notice: UpdateNotice | null =
                    activity.kind === 'engine.update-available' ? { version: activity.version } : null;
                queryClient.setQueryData(homeKeys.updateNotice(), notice);
                void queryClient.invalidateQueries({ queryKey: securityKeys.overview() });
            }
        },
        onReconnect: () => {
            void queryClient.invalidateQueries({ queryKey: activityKeys.all });
        },
    });
}
