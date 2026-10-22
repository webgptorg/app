import type { IntegrationId, ReadIntegration } from '@ptbk/engine-api';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { integrationKeys } from './integrations-keys';

export interface IntegrationPageData {
    readonly items: readonly ReadIntegration[];
    readonly nextCursor: string | null;
}

/** Every cached copy of one integration (its detail and each list page holding it), changed the same way. */
export function updateCachedIntegration(
    queryClient: QueryClient,
    integrationId: IntegrationId,
    change: (integration: ReadIntegration) => ReadIntegration,
): void {
    const detail = queryClient.getQueryData<ReadIntegration>(integrationKeys.detail(integrationId));
    if (detail !== undefined) queryClient.setQueryData(integrationKeys.detail(integrationId), change(detail));
    queryClient.setQueriesData<IntegrationPageData>({ queryKey: integrationKeys.lists() }, (page) =>
        page === undefined || !page.items.some(({ id }) => id === integrationId)
            ? page
            : { ...page, items: page.items.map((item) => (item.id === integrationId ? change(item) : item)) },
    );
}

export interface IntegrationCacheSnapshot {
    readonly integrationId: IntegrationId;
    readonly detail: ReadIntegration | undefined;
    readonly lists: readonly (readonly [QueryKey, IntegrationPageData | undefined])[];
}

export function snapshotIntegration(queryClient: QueryClient, integrationId: IntegrationId): IntegrationCacheSnapshot {
    return {
        integrationId,
        detail: queryClient.getQueryData<ReadIntegration>(integrationKeys.detail(integrationId)),
        lists: queryClient.getQueriesData<IntegrationPageData>({ queryKey: integrationKeys.lists() }),
    };
}

export function restoreIntegration(queryClient: QueryClient, snapshot: IntegrationCacheSnapshot): void {
    queryClient.setQueryData(integrationKeys.detail(snapshot.integrationId), snapshot.detail);
    for (const [queryKey, page] of snapshot.lists) queryClient.setQueryData(queryKey, page);
}
