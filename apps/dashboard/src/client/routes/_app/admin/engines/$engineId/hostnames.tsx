import { EngineId } from '@ptbk/protocol';
import { createFileRoute, notFound } from '@tanstack/react-router';

import { adminHostnamesQuery } from '../../../../../features/admin/hostnames/hostname-queries';
import { AdminHostnamesPage } from '../../../../../features/admin/hostnames/admin-hostnames-page';

export const Route = createFileRoute('/_app/admin/engines/$engineId/hostnames')({
    beforeLoad: ({ params }) => {
        if (!EngineId.safeParse(params.engineId).success) {
            throw notFound();
        }
    },
    // Prefetch only, failures swallowed: the page shows its own loading and error state.
    loader: ({ context, params }) => {
        void context.queryClient.query(adminHostnamesQuery(context.apiClient, params.engineId)).catch(() => undefined);
    },
    component: function HostnamesRoute() {
        return <AdminHostnamesPage engineId={Route.useParams().engineId} />;
    },
});
