import { EngineId } from '@ptbk/protocol';
import { createFileRoute, notFound } from '@tanstack/react-router';

import { adminEngineQuery } from '../../../../../api/queries';
import { AdminEnginePage } from '../../../../../features/admin/engines/admin-engine-page';

export const Route = createFileRoute('/_app/admin/engines/$engineId/')({
    beforeLoad: ({ params }) => {
        if (!EngineId.safeParse(params.engineId).success) {
            throw notFound();
        }
    },
    // Prefetch only, failures swallowed: the page shows its own loading and error state.
    loader: ({ context, params }) => {
        void context.queryClient.query(adminEngineQuery(context.apiClient, params.engineId)).catch(() => undefined);
    },
    component: function AdminEngineRoute() {
        return <AdminEnginePage engineId={Route.useParams().engineId} />;
    },
});
