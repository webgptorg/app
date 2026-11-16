import type { ReadTriggerFire, TriggerId } from '@ptbk/engine-api';
import { createDataTableColumnHelper, DataTable, EmptyState } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { Activity, AlignLeft, CalendarClock, CircleDot, History } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useCursorPages } from '../../app/cursor-pages';
import { m } from '../../paraglide/messages';
import { EntityChip } from '../entities/entity-chip';
import { FireOutcomePill } from './trigger-labels';
import { ExactFireTime } from './trigger-time';
import { useTriggerFires } from './triggers-queries';
import { useRunLinks } from './use-run-links';

const NO_FIRES: readonly ReadTriggerFire[] = [];
const ICON = 'size-3.5';

function useFireColumns(
    linkRuns: boolean,
    errors: boolean,
    zone: string | undefined,
): DataTableColumnDef<ReadTriggerFire>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<ReadTriggerFire>();
        const columns: DataTableColumnDef<ReadTriggerFire>[] = [
            column.accessor('at', {
                header: m.trigger_fires_column_at(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0, icon: <CalendarClock className={ICON} /> },
                cell: ({ row }) => <ExactFireTime at={row.original.at} zone={zone} />,
            }),
            column.accessor('outcome', {
                header: m.trigger_fires_column_outcome(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 1, trailing: true, icon: <CircleDot className={ICON} /> },
                cell: ({ row }) => <FireOutcomePill outcome={row.original.outcome} />,
            }),
        ];
        if (linkRuns) {
            columns.push(
                column.accessor('runId', {
                    header: m.trigger_fires_column_run(),
                    enableSorting: false,
                    meta: { priority: 2, icon: <Activity className={ICON} /> },
                    cell: ({ row }) =>
                        row.original.runId === null ? null : (
                            <EntityChip kind="run" id={row.original.runId} name={m.activity_run_chip()} />
                        ),
                }),
            );
        }
        if (!errors) return columns;
        columns.push(
            // The engine's summary may quote what the agent read: text only.
            column.accessor((fire) => fire.error?.summary ?? '', {
                id: 'error',
                header: m.trigger_fires_column_error(),
                enableSorting: false,
                meta: { priority: 3, icon: <AlignLeft className={ICON} /> },
                cell: ({ row }) =>
                    row.original.error === null ? null : (
                        <span className="line-clamp-3 break-words whitespace-pre-wrap text-text-muted">
                            {row.original.error.summary}
                        </span>
                    ),
            }),
        );
        return columns;
    }, [linkRuns, errors, zone]);
}

/** The trigger's fire history, newest first, paged on the engine; one quiet line until it first fires. */
export function TriggerFiresTable({ triggerId, zone }: { readonly triggerId: TriggerId; readonly zone?: string }) {
    const [cursor, setCursor] = useState<string | undefined>(undefined);
    const fires = useTriggerFires(triggerId, cursor ?? null);
    const items = fires.data?.items ?? NO_FIRES;
    // Off when no fire on the page failed, so an empty column does not take the room.
    const columns = useFireColumns(
        useRunLinks(),
        items.some((fire) => fire.error !== null),
        zone,
    );
    const paging = useCursorPages(cursor, fires.data?.nextCursor ?? null, setCursor);
    if (fires.isSuccess && items.length === 0 && cursor === undefined) {
        return (
            <EmptyState
                variant="inline"
                headingLevel={3}
                icon={<History aria-hidden />}
                title={m.trigger_fires_empty_title()}
            />
        );
    }
    return (
        <DataTable
            caption={m.trigger_fires_title()}
            columns={columns}
            data={items}
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
        />
    );
}
