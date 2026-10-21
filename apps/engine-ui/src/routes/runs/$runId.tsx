import { RunId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { RunDetailPage } from '../../features/runs/run-detail-page';
import { runQueryOptions } from '../../features/runs/runs-queries';

export const Route = createFileRoute('/runs/$runId')({
    beforeLoad: requireFeature('runs'),
    // Not awaited: the page shows its own skeleton, not-found and retry states for the run.
    loader: ({ context, params }) => {
        const runId = RunId.safeParse(params.runId).data;
        if (runId === undefined) return;
        context.queryClient.query(runQueryOptions(context.engineApi, runId)).catch(() => undefined);
    },
    component: RunDetailPage,
});
