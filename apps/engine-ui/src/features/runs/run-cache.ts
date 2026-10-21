import type { ReadRun, ReadRunDetail, RunId } from '@ptbk/engine-api';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { runKeys } from './runs-keys';

export interface RunPageData {
    readonly items: readonly ReadRun[];
    readonly nextCursor: string | null;
}

/** Every cached copy of one run (its detail and each list page holding it), changed the same way. */
export function updateCachedRun(queryClient: QueryClient, runId: RunId, change: (run: ReadRun) => ReadRun): void {
    const detail = queryClient.getQueryData<ReadRunDetail>(runKeys.detail(runId));
    if (detail !== undefined) queryClient.setQueryData(runKeys.detail(runId), { ...detail, ...change(detail) });
    queryClient.setQueriesData<RunPageData>({ queryKey: runKeys.lists() }, (page) =>
        page === undefined || !page.items.some(({ id }) => id === runId)
            ? page
            : { ...page, items: page.items.map((run) => (run.id === runId ? change(run) : run)) },
    );
}

export interface RunCacheSnapshot {
    readonly runId: RunId;
    readonly detail: ReadRunDetail | undefined;
    readonly lists: readonly (readonly [QueryKey, RunPageData | undefined])[];
}

export function snapshotRun(queryClient: QueryClient, runId: RunId): RunCacheSnapshot {
    return {
        runId,
        detail: queryClient.getQueryData<ReadRunDetail>(runKeys.detail(runId)),
        lists: queryClient.getQueriesData<RunPageData>({ queryKey: runKeys.lists() }),
    };
}

export function restoreRun(queryClient: QueryClient, snapshot: RunCacheSnapshot): void {
    queryClient.setQueryData(runKeys.detail(snapshot.runId), snapshot.detail);
    for (const [queryKey, page] of snapshot.lists) queryClient.setQueryData(queryKey, page);
}
