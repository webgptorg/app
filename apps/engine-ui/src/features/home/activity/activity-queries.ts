import { Timestamp } from '@ptbk/engine-api';
import type { EngineApiClient } from '@ptbk/engine-api';
import { infiniteQueryOptions } from '@tanstack/react-query';

import { unwrap } from '../../../app/api-errors';
import type { ActivityArea } from './activity-areas';
import { FEED_PAGE_SIZE } from './activity-feed-cache';
import type { FeedPage, FeedPageParam } from './activity-feed-cache';
import { activityKeys } from './activity-keys';

/**
 * `GET /activity`, newest first, one page at a time ("Load older"). Live `activity` events are written into this
 * cache by the home feature's event sync, so it never refetches on a timer.
 */
export function activityFeedQueryOptions(engineApi: EngineApiClient, area: ActivityArea | null) {
    return infiniteQueryOptions({
        queryKey: activityKeys.feed(area),
        queryFn: async ({ pageParam, signal }): Promise<FeedPage> => {
            const position =
                pageParam === null
                    ? {}
                    : 'cursor' in pageParam
                      ? { cursor: pageParam.cursor }
                      : { to: Timestamp.parse(pageParam.before) };
            const filter = area === null ? {} : { kind: `${area}.` };
            const page = unwrap(
                await engineApi.activity.list({ limit: FEED_PAGE_SIZE, ...filter, ...position }, signal),
            );
            return { items: page.items, next: page.nextCursor === null ? null : { cursor: page.nextCursor } };
        },
        initialPageParam: null as FeedPageParam,
        getNextPageParam: (last) => last.next,
        staleTime: Number.POSITIVE_INFINITY,
    });
}
