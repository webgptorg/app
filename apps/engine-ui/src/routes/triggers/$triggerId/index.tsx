import { TriggerId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { TriggerOrigin } from '../../../features/triggers/trigger-search';
import { requireFeature } from '../../../app/registry/require-feature';
import { TriggerDetailPage } from '../../../features/triggers/trigger-detail-page';
import { triggerFiresQueryOptions, triggerQueryOptions } from '../../../features/triggers/triggers-queries';

export const Route = createFileRoute('/triggers/$triggerId/')({
    validateSearch: TriggerOrigin,
    beforeLoad: requireFeature('triggers'),
    // Not awaited: the page shows its own skeleton, not-found and retry states.
    loader: ({ context, params }) => {
        const triggerId = TriggerId.safeParse(params.triggerId).data;
        if (triggerId === undefined) return;
        context.queryClient.query(triggerQueryOptions(context.engineApi, triggerId)).catch(() => undefined);
        context.queryClient.query(triggerFiresQueryOptions(context.engineApi, triggerId, null)).catch(() => undefined);
    },
    component: TriggerDetailPage,
});
