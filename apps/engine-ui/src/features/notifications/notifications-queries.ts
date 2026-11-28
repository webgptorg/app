import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { EngineApiClient, NotificationCounts } from '@ptbk/engine-api';
import { infiniteQueryOptions, queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import type { FeatureRequirement } from '../../app/registry/feature';

/** Everyone has an inbox of their own, so the capability is the only requirement. */
export const NOTIFICATIONS: FeatureRequirement = { capability: KNOWN_CAPABILITIES.notifications };

/** The engine sends no event for a new item, so the badge asks again on this interval and on window focus. */
export const NOTIFICATION_COUNTS_REFRESH_MS = 60_000;
const INBOX_PAGE_SIZE = 50;

export const notificationKeys = {
    all: ['notifications'] as const,
    counts: () => [...notificationKeys.all, 'counts'] as const,
    inbox: () => [...notificationKeys.all, 'inbox'] as const,
};

export function notificationCountsQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: notificationKeys.counts(),
        queryFn: async ({ signal }): Promise<NotificationCounts> =>
            unwrap(await engineApi.notifications.counts(signal)),
        refetchInterval: NOTIFICATION_COUNTS_REFRESH_MS,
        refetchOnWindowFocus: true,
    });
}

/** How many unseen items wait for the member; 0 while unknown or when the engine does not answer. */
export function useUnseenNotifications(): number {
    return useQuery(notificationCountsQueryOptions(useEngineApi())).data?.total ?? 0;
}

/** `GET /me/notifications`, newest first, page after page ("Show more"). */
export function inboxQueryOptions(engineApi: EngineApiClient) {
    return infiniteQueryOptions({
        queryKey: notificationKeys.inbox(),
        queryFn: async ({ pageParam, signal }) =>
            unwrap(
                await engineApi.notifications.list(
                    pageParam === null ? { limit: INBOX_PAGE_SIZE } : { limit: INBOX_PAGE_SIZE, cursor: pageParam },
                    signal,
                ),
            ),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor,
    });
}
