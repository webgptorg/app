import type { ReadTrigger, TriggerId } from '@ptbk/engine-api';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { triggerKeys } from './triggers-keys';

export interface TriggerPageData {
    readonly items: readonly ReadTrigger[];
    readonly nextCursor: string | null;
}

/** Every cached copy of one trigger (its detail and each list page holding it), changed the same way. */
export function updateCachedTrigger(
    queryClient: QueryClient,
    triggerId: TriggerId,
    change: (trigger: ReadTrigger) => ReadTrigger,
): void {
    const detail = queryClient.getQueryData<ReadTrigger>(triggerKeys.detail(triggerId));
    if (detail !== undefined) queryClient.setQueryData(triggerKeys.detail(triggerId), change(detail));
    queryClient.setQueriesData<TriggerPageData>({ queryKey: triggerKeys.lists() }, (page) =>
        page === undefined || !page.items.some(({ id }) => id === triggerId)
            ? page
            : { ...page, items: page.items.map((trigger) => (trigger.id === triggerId ? change(trigger) : trigger)) },
    );
}

export interface TriggerCacheSnapshot {
    readonly triggerId: TriggerId;
    readonly detail: ReadTrigger | undefined;
    readonly lists: readonly (readonly [QueryKey, TriggerPageData | undefined])[];
}

export function snapshotTrigger(queryClient: QueryClient, triggerId: TriggerId): TriggerCacheSnapshot {
    return {
        triggerId,
        detail: queryClient.getQueryData<ReadTrigger>(triggerKeys.detail(triggerId)),
        lists: queryClient.getQueriesData<TriggerPageData>({ queryKey: triggerKeys.lists() }),
    };
}

export function restoreTrigger(queryClient: QueryClient, snapshot: TriggerCacheSnapshot): void {
    queryClient.setQueryData(triggerKeys.detail(snapshot.triggerId), snapshot.detail);
    for (const [queryKey, page] of snapshot.lists) queryClient.setQueryData(queryKey, page);
}
