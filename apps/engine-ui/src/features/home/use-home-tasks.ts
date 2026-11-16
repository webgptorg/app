import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { ReadTask, TaskState } from '@ptbk/engine-api';
import { useInfiniteQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { taskListQueryOptions } from '../tasks/tasks-queries';

const HOME_TASK_LIMIT = 10;

/**
 * The first tasks in one state, for a Home section. Only with `tasks@1` and `tasks.read`, and never page-level: a
 * failing task list costs its section, not Home. `undefined` while loading.
 */
export function useHomeTasks(state: TaskState): { readonly tasks: readonly ReadTask[] | undefined } {
    const allowed = useAllows({ capability: KNOWN_CAPABILITIES.tasks, permission: 'tasks.read' });
    const list = useInfiniteQuery({
        ...taskListQueryOptions(useEngineApi(), { limit: HOME_TASK_LIMIT, state }),
        enabled: allowed,
    });
    if (!allowed || list.isError) return { tasks: [] };
    return { tasks: list.data?.pages.flatMap((page) => page.items) };
}
