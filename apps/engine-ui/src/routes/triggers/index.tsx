import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { triggerListParams, TriggerSearch } from '../../features/triggers/trigger-search';
import { TriggersPage } from '../../features/triggers/triggers-page';
import { triggerListQueryOptions } from '../../features/triggers/triggers-queries';

export const Route = createFileRoute('/triggers/')({
    beforeLoad: requireFeature('triggers'),
    validateSearch: TriggerSearch,
    loaderDeps: ({ search }) => triggerListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads, and shows its own error.
    loader: ({ context, deps }) => {
        context.queryClient.query(triggerListQueryOptions(context.engineApi, deps)).catch(() => undefined);
    },
    component: TriggersPage,
});
