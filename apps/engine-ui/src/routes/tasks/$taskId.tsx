import { TaskId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { TaskDetailPage } from '../../features/tasks/task-detail-page';
import { taskQueryOptions } from '../../features/tasks/tasks-queries';

export const Route = createFileRoute('/tasks/$taskId')({
    beforeLoad: requireFeature('tasks'),
    // Not awaited: the page shows its own skeleton, not-found and retry states for the task.
    loader: ({ context, params }) => {
        const taskId = TaskId.safeParse(params.taskId).data;
        if (taskId === undefined) return;
        context.queryClient.query(taskQueryOptions(context.engineApi, taskId)).catch(() => undefined);
    },
    component: TaskDetailPage,
});
