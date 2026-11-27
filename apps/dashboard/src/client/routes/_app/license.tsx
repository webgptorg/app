import { createFileRoute } from '@tanstack/react-router';

import { licenseQuery } from '../../api/queries';
import { LicensePage } from '../../features/licensing/license-page';
import { requireLicensing } from '../../features/session/session-guards';

export const Route = createFileRoute('/_app/license')({
    beforeLoad: ({ context }) => {
        requireLicensing(context.session);
    },
    // Prefetch only, failures swallowed: the page shows its own loading and error state.
    loader: ({ context }) => {
        void context.queryClient.query(licenseQuery(context.apiClient)).catch(() => undefined);
    },
    component: LicensePage,
});
