import {
    Badge,
    Banner,
    Button,
    Card,
    CodeText,
    ConfirmDialog,
    createDataTableColumnHelper,
    DataTable,
    RelativeTime,
} from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { m } from '../../../../paraglide/messages';
import { apiRoutes, type CnameLookupView, type CustomHostnameView } from '../../../../shared/api/routes';
import { useApiClient } from '../../../api/api-client-context';
import { dataOrThrow, problemCode } from '../../../api/queries';
import { useBrowser } from '../../../core/browser';
import { useAppMutation } from '../../../core/mutations';
import { AddHostnameCard } from './add-hostname-card';
import { adminHostnamesKey, adminHostnamesQuery } from './hostname-queries';

const columns = createDataTableColumnHelper<CustomHostnameView>();

function lookupText(lookup: CnameLookupView): string {
    switch (lookup.kind) {
        case 'cname':
            return m.admin_hostnames_found_cname({ target: lookup.target });
        case 'none':
            return m.admin_hostnames_found_none();
        case 'error':
            return m.admin_hostnames_found_error();
    }
}

function checkMessage(hostname: CustomHostnameView, lookup: CnameLookupView): string {
    if (lookup.kind === 'error') {
        return m.admin_hostnames_checked_error();
    }
    return hostname.status === 'active'
        ? m.admin_hostnames_checked_active({ hostname: hostname.hostname })
        : m.admin_hostnames_checked_pending({ hostname: hostname.hostname });
}

/**
 * `/admin/engines/$engineId/hostnames` (D-08): an engine's custom hostnames with the CNAME target next to each, so
 * the admin can hand it to the customer, and what the last DNS check found when it did not match.
 */
export function AdminHostnamesPage(props: { readonly engineId: string }) {
    const api = useApiClient();
    const browser = useBrowser();
    const { engineId } = props;
    const list = useQuery(adminHostnamesQuery(api, engineId));
    const [now] = useState(() => new Date(browser.now()));
    const [lookups, setLookups] = useState<ReadonlyMap<string, CnameLookupView>>(new Map());
    const [removing, setRemoving] = useState<CustomHostnameView | null>(null);
    const invalidates = [adminHostnamesKey(engineId)];

    const check = useAppMutation({
        mutationFn: async (hostname: CustomHostnameView) =>
            dataOrThrow(
                await api.call(apiRoutes.adminCheckHostname, { params: { engineId, hostname: hostname.hostname } }),
            ),
        invalidates,
        successMessage: (data) => checkMessage(data.hostname, data.lookup),
        onSuccess: (data) => {
            setLookups((current) => new Map(current).set(data.hostname.hostname, data.lookup));
        },
    });
    const remove = useAppMutation({
        mutationFn: async (hostname: CustomHostnameView) =>
            dataOrThrow(
                await api.call(apiRoutes.adminRemoveHostname, { params: { engineId, hostname: hostname.hostname } }),
            ),
        invalidates,
        successMessage: () => m.admin_hostnames_removed(),
        onSuccess: () => {
            setRemoving(null);
        },
    });

    const expectedTarget = list.data?.expectedTarget;
    const checking = check.isPending ? check.variables.hostname : null;
    const runCheck = check.mutate;
    const tableColumns = useMemo(
        (): DataTableColumnDef<CustomHostnameView>[] => [
            columns.accessor('hostname', {
                header: m.admin_hostnames_column_hostname(),
                cell: (context) => <CodeText value={context.row.original.hostname} />,
                meta: { priority: 0 },
            }),
            columns.accessor('status', {
                header: m.admin_hostnames_column_status(),
                cell: (context) =>
                    context.row.original.status === 'active' ? (
                        <Badge tone="success">{m.admin_hostnames_status_active()}</Badge>
                    ) : (
                        <Badge tone="warning">{m.admin_hostnames_status_pending()}</Badge>
                    ),
                meta: { priority: 1 },
            }),
            columns.display({
                id: 'target',
                header: m.admin_hostnames_column_target(),
                cell: (context) => {
                    const lookup = lookups.get(context.row.original.hostname);
                    const mismatch =
                        lookup !== undefined && !(lookup.kind === 'cname' && lookup.target === expectedTarget);
                    return (
                        <span className="flex flex-col gap-1">
                            {expectedTarget === undefined ? null : <CodeText value={expectedTarget} />}
                            {mismatch ? <span className="text-sm text-danger">{lookupText(lookup)}</span> : null}
                        </span>
                    );
                },
                meta: { label: m.admin_hostnames_column_target(), priority: 2 },
            }),
            columns.accessor('dnsCheckedAt', {
                header: m.admin_hostnames_column_checked(),
                cell: (context) => {
                    const checkedAt = context.row.original.dnsCheckedAt;
                    return checkedAt === null ? (
                        m.admin_hostnames_never_checked()
                    ) : (
                        <RelativeTime value={new Date(checkedAt)} now={now} />
                    );
                },
                meta: { priority: 3 },
            }),
            columns.display({
                id: 'actions',
                header: () => <span className="sr-only">{m.admin_hostnames_column_actions()}</span>,
                cell: (context) => {
                    const hostname = context.row.original;
                    return (
                        <span className="flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                variant="secondary"
                                loading={checking === hostname.hostname}
                                aria-label={m.admin_hostnames_check_named({ hostname: hostname.hostname })}
                                onClick={() => {
                                    runCheck(hostname);
                                }}
                            >
                                {m.admin_hostnames_check()}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-label={m.admin_hostnames_remove_named({ hostname: hostname.hostname })}
                                onClick={() => {
                                    setRemoving(hostname);
                                }}
                            >
                                {m.admin_hostnames_remove()}
                            </Button>
                        </span>
                    );
                },
                meta: { label: m.admin_hostnames_column_actions(), priority: 4 },
            }),
        ],
        [checking, expectedTarget, lookups, now, runCheck],
    );

    if (problemCode(list.error) === 'not-found') {
        return (
            <div className="flex flex-col gap-6">
                <h1 className="font-display text-2xl font-semibold">{m.admin_hostnames_title()}</h1>
                <Banner tone="warning">{m.admin_hostnames_engine_not_found()}</Banner>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.admin_hostnames_title()}</h1>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
                <dt className="text-text-muted">{m.admin_hostnames_engine_label()}</dt>
                <dd>
                    <CodeText value={engineId} />
                </dd>
                {list.data === undefined ? null : (
                    <>
                        <dt className="text-text-muted">{m.admin_hostnames_org_label()}</dt>
                        <dd>
                            <CodeText value={list.data.orgId} />
                        </dd>
                    </>
                )}
            </dl>
            <p className="text-sm text-text-muted">{m.admin_hostnames_intro()}</p>
            {expectedTarget === undefined ? null : (
                <Card title={m.admin_hostnames_target_title()}>
                    <div className="flex flex-col gap-3">
                        <p className="text-sm">{m.admin_hostnames_target_body()}</p>
                        <CodeText value={expectedTarget} copyable copyLabel={m.admin_hostnames_copy_target()} />
                    </div>
                </Card>
            )}
            <DataTable<CustomHostnameView>
                caption={m.admin_hostnames_title()}
                mode="client"
                columns={tableColumns}
                data={list.data?.hostnames ?? []}
                getRowId={(row) => row.hostname}
                getRowLabel={(row) => row.hostname}
                loading={list.isPending}
                {...(list.isError
                    ? {
                          error: {
                              message: m.admin_hostnames_load_failed(),
                              onRetry: () => void list.refetch(),
                              retrying: list.isFetching,
                          },
                      }
                    : {})}
                empty={{ title: m.admin_hostnames_empty_title(), description: m.admin_hostnames_empty_body() }}
                skeletonRows={2}
            />
            <AddHostnameCard engineId={engineId} />
            <ConfirmDialog
                open={removing !== null}
                onClose={() => {
                    setRemoving(null);
                }}
                onConfirm={() => {
                    if (removing !== null) {
                        remove.mutate(removing);
                    }
                }}
                title={m.admin_hostnames_remove_title()}
                description={m.admin_hostnames_remove_body({ hostname: removing?.hostname ?? '' })}
                confirmLabel={m.admin_hostnames_remove()}
                tone="danger"
                loading={remove.isPending}
            />
        </div>
    );
}
