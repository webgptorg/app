import { AgentId, DEFAULT_PAGE_LIMIT, TaskKind } from '@ptbk/engine-api';
import { z } from 'zod';

import { TASK_STATUS_GROUP_IDS, TASK_STATUS_GROUPS } from './task-state';
import type { TaskStatusGroup } from './task-state';
import type { TaskListParams } from './tasks-keys';

const MAX_SEARCH_LENGTH = 256;

/** Status groups as the URL writes them, `blocked,waiting`, in the canonical order; unknown ones are dropped. */
const GroupSet = z
    .string()
    .max(256)
    .transform((value) => {
        const parts = new Set(value.split(','));
        return TASK_STATUS_GROUP_IDS.filter((group) => parts.has(group)).join(',');
    })
    .refine((value) => value !== '');

/** The list's state in the URL, so a filtered view can be linked and survives a reload; bad values mean no filter. */
export const TaskSearch = z.object({
    q: z.string().trim().min(1).max(MAX_SEARCH_LENGTH).optional().catch(undefined),
    status: GroupSet.optional().catch(undefined),
    agentId: AgentId.optional().catch(undefined),
    kind: TaskKind.optional().catch(undefined),
});
export type TaskSearch = z.output<typeof TaskSearch>;

export function selectedGroups(search: TaskSearch): readonly TaskStatusGroup[] {
    const parts = search.status?.split(',') ?? [];
    return TASK_STATUS_GROUP_IDS.filter((group) => parts.includes(group));
}

export function hasTaskFilters(search: TaskSearch): boolean {
    return (
        search.q !== undefined ||
        search.status !== undefined ||
        search.agentId !== undefined ||
        search.kind !== undefined
    );
}

/** The engine's query: status groups expand to the engine's own states; the engine keeps its order. */
export function taskListParams(search: TaskSearch): TaskListParams {
    const states = selectedGroups(search).flatMap((group) => TASK_STATUS_GROUPS[group]);
    return {
        limit: DEFAULT_PAGE_LIMIT,
        ...(states.length === 0 ? {} : { state: states.join(',') }),
        ...(search.q === undefined ? {} : { q: search.q }),
        ...(search.agentId === undefined ? {} : { agentId: search.agentId }),
        ...(search.kind === undefined ? {} : { kind: search.kind }),
    };
}
