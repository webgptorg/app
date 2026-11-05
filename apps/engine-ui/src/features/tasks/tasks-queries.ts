import type { EngineApiClient, TaskId } from '@ptbk/engine-api';
import { infiniteQueryOptions, queryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { taskKeys } from './tasks-keys';
import type { TaskListParams } from './tasks-keys';

/** Tasks change on the engine's side; every change arrives as a `task.changed` event, so nothing polls. */
const TASK_STALE_MS = Number.POSITIVE_INFINITY;

/**
 * `GET /tasks` in the engine's own order, page after page: the inventory is read top-down ("Show more"), so earlier
 * groups stay on screen while later work loads.
 */
export function taskListQueryOptions(engineApi: EngineApiClient, params: TaskListParams) {
    return infiniteQueryOptions({
        queryKey: taskKeys.list(params),
        queryFn: async ({ signal, pageParam }) =>
            unwrap(await engineApi.tasks.list(pageParam === null ? params : { ...params, cursor: pageParam }, signal)),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor,
        staleTime: TASK_STALE_MS,
    });
}

/** `GET /tasks/{taskId}`: the task with its children, dependants, links and notes. */
export function taskQueryOptions(engineApi: EngineApiClient, taskId: TaskId) {
    return queryOptions({
        queryKey: taskKeys.detail(taskId),
        queryFn: async ({ signal }) => unwrap(await engineApi.tasks.get(taskId, signal)),
        staleTime: TASK_STALE_MS,
    });
}

/** `GET /tasks/{taskId}/occurrences`, newest first, page after page. */
export function taskOccurrencesQueryOptions(engineApi: EngineApiClient, taskId: TaskId) {
    return infiniteQueryOptions({
        queryKey: taskKeys.occurrences(taskId),
        queryFn: async ({ signal, pageParam }) =>
            unwrap(
                await engineApi.tasks.listOccurrences(taskId, pageParam === null ? {} : { cursor: pageParam }, signal),
            ),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor,
        staleTime: TASK_STALE_MS,
    });
}

export function useTaskList(params: TaskListParams) {
    return useInfiniteQuery({ ...taskListQueryOptions(useEngineApi(), params), throwOnError: isPageLevelFailure });
}

export function useTask(taskId: TaskId) {
    return useQuery({ ...taskQueryOptions(useEngineApi(), taskId), throwOnError: isPageLevelFailure });
}

export function useTaskOccurrences(taskId: TaskId) {
    return useInfiniteQuery(taskOccurrencesQueryOptions(useEngineApi(), taskId));
}
