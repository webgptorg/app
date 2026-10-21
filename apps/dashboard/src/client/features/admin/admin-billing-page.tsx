import { Badge, CodeText, createDataTableColumnHelper, DataTable, RelativeTime } from '@ptbk/ui';
import { useLocale as useFormatters } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { m } from '../../../paraglide/messages';
import type { ProblemOrganization } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { adminBillingQuery } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { STATUS_LABELS, STATUS_TONES } from '../billing/billing-labels';

const columns = createDataTableColumnHelper<ProblemOrganization>();

function organizationName(organization: ProblemOrganization): string {
    if (organization.name !== null) {
        return organization.name;
    }
    return organization.kind === 'personal' ? m.org_personal() : m.admin_billing_unnamed();
}

/**
 * `/admin/billing`: organizations whose payments need a person to look at them. Nothing is suspended automatically;
 * the manual suspend action arrives with I-05.
 */
export function AdminBillingPage() {
    const api = useApiClient();
    const browser = useBrowser();
    const formatters = useFormatters();
    const organizations = useQuery(adminBillingQuery(api));
    const [now] = useState(() => new Date(browser.now()));

    const tableColumns = useMemo(
        (): DataTableColumnDef<ProblemOrganization>[] => [
            columns.accessor('orgId', {
                header: m.admin_billing_column_org(),
                cell: (context) => (
                    <span className="flex flex-col gap-1">
                        <span className="font-medium">{organizationName(context.row.original)}</span>
                        <CodeText value={context.row.original.orgId} />
                    </span>
                ),
                meta: { priority: 0 },
            }),
            columns.accessor('status', {
                header: m.admin_billing_column_status(),
                cell: (context) => (
                    <Badge tone={STATUS_TONES[context.row.original.status]}>
                        {STATUS_LABELS[context.row.original.status]()}
                    </Badge>
                ),
                meta: { priority: 1 },
            }),
            columns.accessor('currentPeriodEnd', {
                header: m.admin_billing_column_period_end(),
                cell: (context) => {
                    const end = context.row.original.currentPeriodEnd;
                    return end === null ? m.admin_billing_no_period() : formatters.formatDate(new Date(end));
                },
                meta: { priority: 2 },
            }),
            columns.accessor('updatedAt', {
                header: m.admin_billing_column_updated(),
                cell: (context) => <RelativeTime value={new Date(context.row.original.updatedAt)} now={now} />,
                meta: { priority: 3 },
            }),
        ],
        [formatters, now],
    );

    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.admin_billing_title()}</h1>
            <p className="text-sm text-text-muted">{m.admin_billing_body()}</p>
            <DataTable<ProblemOrganization>
                caption={m.admin_billing_title()}
                mode="client"
                columns={tableColumns}
                data={organizations.data ?? []}
                getRowId={(row) => row.orgId}
                getRowLabel={organizationName}
                loading={organizations.isPending}
                {...(organizations.isError
                    ? {
                          error: {
                              message: m.admin_billing_load_failed(),
                              onRetry: () => void organizations.refetch(),
                              retrying: organizations.isFetching,
                          },
                      }
                    : {})}
                empty={{ title: m.admin_billing_empty_title(), description: m.admin_billing_empty_body() }}
                skeletonRows={2}
            />
        </div>
    );
}
