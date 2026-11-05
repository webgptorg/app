import type { TaskListQuery, TaskOccurrenceListQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type TaskListParams = z.input<typeof TaskListQuery>;
export type TaskOccurrenceParams = z.input<typeof TaskOccurrenceListQuery>;

export const taskKeys = {
    all: ['tasks'] as const,
    lists: () => [...taskKeys.all, 'list'] as const,
    list: (params: TaskListParams) => [...taskKeys.lists(), params] as const,
    details: () => [...taskKeys.all, 'detail'] as const,
    detail: (taskId: string) => [...taskKeys.details(), taskId] as const,
    occurrences: (taskId: string) => [...taskKeys.detail(taskId), 'occurrences'] as const,
};
