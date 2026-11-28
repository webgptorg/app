import { queryOptions } from '@tanstack/react-query';

import { notificationRoutes } from '../../../shared/api/notification-routes';
import type { ApiClient } from '../../api/api-client';
import { dataOrThrow, queryKeys } from '../../api/queries';

/** The bell follows quietly while the tab is in front: on focus and once a minute, like the project list. */
export const NOTIFICATIONS_REFETCH_MS = 60_000;

/** The active organization's open notifications, and which other organizations have something unseen. */
export function notificationsQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.notifications,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(notificationRoutes.listNotifications, {}, signal)),
        refetchInterval: NOTIFICATIONS_REFETCH_MS,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
    });
}

export function notificationPreferencesQuery(client: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.notificationPreferences,
        queryFn: async ({ signal }) =>
            dataOrThrow(await client.call(notificationRoutes.listNotificationPreferences, {}, signal)).preferences,
    });
}
