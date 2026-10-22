import type { ReadTriggerFire, TriggerId } from '@ptbk/engine-api';
import { createDataTableColumnHelper, DataTable } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { useMemo, useState } from 'react';

import { useCursorPages } from '../../app/cursor-pages';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { FireOutcomeBadge } from './trigger-labels';
import { FireTime } from './trigger-time';
import { useTriggerFires } from './triggers-queries';
import { useRunLinks } from './use-run-links';

const NO_FIRES: readonly ReadTriggerFire[] = [];

function useFireColumns(linkRuns: boolean, zone: string | undefined): DataTableColumnDef<ReadTriggerFire>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<ReadTriggerFire>();
        const columns: DataTableColumnDef<ReadTriggerFire>[] = [
            column.accessor('at', {
                header: m.trigger_fires_column_at(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0 },
                cell: ({ row }) => <FireTime at={row.original.at} zone={zone} />,
            }),
            column.accessor('outcome', {
                header: m.trigger_fires_column_outcome(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 1 },
                cell: ({ row }) => <FireOutcomeBadge outcome={row.original.outcome} />,
            }),
            // The engine's summary may quote what the agent read: text only.
            column.accessor((fire) => fire.error?.summary ?? '', {
                id: 'error',
                header: m.trigger_fires_column_error(),
                enableSorting: false,
                meta: { priority: 3 },
                cell: ({ row }) =>
                    row.original.error === null ? null : (
                        <span className="break-words whitespace-pre-wrap">{row.original.error.summary}</span>
                    ),
            }),
        ];
        if (linkRuns) {
            columns.push(
                column.accessor('runId', {
                    header: m.trigger_fires_column_run(),
                    enableSorting: false,
                    meta: { priority: 2 },
                    cell: ({ row }) =>
                        row.original.runId === null ? null : (
                            <Link to="/runs/$runId" params={{ runId: row.original.runId }}>
                                {m.trigger_fires_open_run()}
                            </Link>
                        ),
                }),
            );
        }
        return columns;
    }, [linkRuns, zone]);
}

/** The trigger's fire history, newest first, paged on the engine. */
export function TriggerFiresTable({ triggerId, zone }: { readonly triggerId: TriggerId; readonly zone?: string }) {
    const [cursor, setCursor] = useState<string | undefined>(undefined);
    const fires = useTriggerFires(triggerId, cursor ?? null);
    const columns = useFireColumns(useRunLinks(), zone);
    const paging = useCursorPages(cursor, fires.data?.nextCursor ?? null, setCursor);
    return (
        <DataTable
            caption={m.trigger_fires_title()}
            showCaption
            columns={columns}
            data={fires.data?.items ?? NO_FIRES}
            getRowId={(fire) => fire.id}
            getRowLabel={(fire) => fire.at}
            page={paging.page}
            onPageChange={paging.onPageChange}
            loading={fires.isPending}
            fetching={fires.isFetching && !fires.isPending}
            skeletonRows={3}
            {...(fires.isError
                ? {
                      error: {
                          message: m.trigger_fires_load_failed(),
                          onRetry: () => {
                              void fires.refetch();
                          },
                          retrying: fires.isFetching,
                      },
                  }
                : {})}
            empty={{ title: m.trigger_fires_empty_title(), description: m.trigger_fires_empty_body() }}
        />
    );
}
