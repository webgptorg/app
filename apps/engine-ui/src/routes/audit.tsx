import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { auditChainStatusQueryOptions, auditLogQueryOptions } from '../features/audit/audit-queries';
import { auditListParams, AuditSearch } from '../features/audit/audit-search';
import { AuditPage } from '../features/audit/audit-page';

export const Route = createFileRoute('/audit')({
    beforeLoad: requireFeature('audit'),
    validateSearch: AuditSearch,
    loaderDeps: ({ search }) => auditListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads.
    loader: ({ context, deps }) => {
        context.queryClient.query(auditLogQueryOptions(context.engineApi, deps)).catch(() => undefined);
        context.queryClient.query(auditChainStatusQueryOptions(context.engineApi)).catch(() => undefined);
    },
    component: AuditPage,
});
