import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { RunsPage } from '../../features/runs/runs-page';
import { runListParams, RunSearch } from '../../features/runs/run-search';
import { runListQueryOptions } from '../../features/runs/runs-queries';

export const Route = createFileRoute('/runs/')({
    beforeLoad: requireFeature('runs'),
    validateSearch: RunSearch,
    loaderDeps: ({ search }) => runListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads, and shows its own error.
    loader: ({ context, deps }) => {
        context.queryClient.query(runListQueryOptions(context.engineApi, deps)).catch(() => undefined);
    },
    component: RunsPage,
});
