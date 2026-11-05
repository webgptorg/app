import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { TaskSearch, taskListParams } from '../../features/tasks/task-search';
import { TasksPage } from '../../features/tasks/tasks-page';
import { taskListQueryOptions } from '../../features/tasks/tasks-queries';

export const Route = createFileRoute('/tasks/')({
    beforeLoad: requireFeature('tasks'),
    validateSearch: TaskSearch,
    loaderDeps: ({ search }) => taskListParams(search),
    // Not awaited: the page shows its own skeleton and error.
    loader: ({ context, deps }) => {
        context.queryClient.infiniteQuery(taskListQueryOptions(context.engineApi, deps)).catch(() => undefined);
    },
    component: TasksPage,
});
