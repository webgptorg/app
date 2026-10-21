import { createFileRoute } from '@tanstack/react-router';

import { adminBillingQuery } from '../../../api/queries';
import { AdminBillingPage } from '../../../features/admin/admin-billing-page';

export const Route = createFileRoute('/_app/admin/billing')({
    // Prefetch only, failures swallowed: the table shows its own loading and error state.
    loader: ({ context }) => {
        void context.queryClient.query(adminBillingQuery(context.apiClient)).catch(() => undefined);
    },
    component: AdminBillingPage,
});
