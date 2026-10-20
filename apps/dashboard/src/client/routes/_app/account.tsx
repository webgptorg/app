import { createFileRoute } from '@tanstack/react-router';

import { passkeysQuery, sessionsQuery } from '../../api/queries';
import { AccountPage } from '../../features/account/account-page';

export const Route = createFileRoute('/_app/account')({
    // Prefetch only, failures swallowed: each card shows its own loading and error state, so neither blocks the page.
    loader: ({ context }) => {
        void context.queryClient.query(passkeysQuery(context.apiClient)).catch(() => undefined);
        void context.queryClient.query(sessionsQuery(context.apiClient)).catch(() => undefined);
    },
    component: AccountPage,
});
