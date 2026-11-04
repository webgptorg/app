import { createFileRoute } from '@tanstack/react-router';

import { adminBillingQuery } from '../../../api/queries';
import { AdminBillingPage } from '../../../features/admin/admin-billing-page';
import { requireBilling } from '../../../features/session/session-guards';

export const Route = createFileRoute('/_app/admin/billing')({
    beforeLoad: ({ context }) => {
        requireBilling(context.session);
    },
    // Prefetch only, failures swallowed: the table shows its own loading and error state.
    loader: ({ context }) => {
        void context.queryClient.query(adminBillingQuery(context.apiClient)).catch(() => undefined);
    },
    component: AdminBillingPage,
});
