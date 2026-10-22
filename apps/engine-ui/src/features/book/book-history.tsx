import type { AgentId, RevisionId, RevisionSummary } from '@ptbk/engine-api';
import { Badge, Button, createDataTableColumnHelper, DataTable, RelativeTime } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { AgentCreator } from '../agents/agent-creator';
import { revisionPageQueryOptions } from './book-queries';

const NO_REVISIONS: readonly RevisionSummary[] = [];

export interface BookHistoryProps {
    readonly agentId: AgentId;
    readonly currentRevisionId: RevisionId;
    readonly onOpen: (revision: RevisionSummary) => void;
}

function useRevisionColumns(
    currentRevisionId: RevisionId,
    onOpen: (revision: RevisionSummary) => void,
): DataTableColumnDef<RevisionSummary>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<RevisionSummary>();
        return [
            column.accessor('createdAt', {
                header: m.book_history_column_saved(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0 },
                cell: ({ row }) => (
                    <span className="inline-flex flex-wrap items-center gap-2">
                        <RelativeTime value={new Date(row.original.createdAt)} />
                        {row.original.id === currentRevisionId ? (
                            <Badge tone="success">{m.book_history_current()}</Badge>
                        ) : null}
                    </span>
                ),
            }),
            column.accessor('createdBy', {
                header: m.book_history_column_author(),
                enableSorting: false,
                meta: { priority: 1 },
                cell: ({ row }) => <AgentCreator memberId={row.original.createdBy} />,
            }),
            column.display({
                id: 'open',
                header: () => <span className="sr-only">{m.book_history_column_open()}</span>,
                enableHiding: false,
                meta: { priority: 0 },
                cell: ({ row }) => (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                            onOpen(row.original);
                        }}
                    >
                        {m.book_history_view()}
                    </Button>
                ),
            }),
        ];
    }, [currentRevisionId, onOpen]);
}

/** The book's versions, newest first, a page at a time; opening one shows it read-only, with a diff and restore. */
export function BookHistory({ agentId, currentRevisionId, onOpen }: BookHistoryProps) {
    const engineApi = useEngineApi();
    const [cursor, setCursor] = useState<string | undefined>(undefined);
    const revisions = useQuery({
        ...revisionPageQueryOptions(engineApi, agentId, cursor),
        placeholderData: keepPreviousData,
    });
    const pages = useCursorPages(cursor, revisions.data?.nextCursor ?? null, setCursor);
    const columns = useRevisionColumns(currentRevisionId, onOpen);

    return (
        <section aria-labelledby="book-history-title" className="flex min-w-0 flex-col gap-3">
            <h2 id="book-history-title" className="text-base font-semibold">
                {m.book_history_title()}
            </h2>
            <DataTable
                caption={m.book_history_title()}
                columns={columns}
                data={revisions.data?.items ?? NO_REVISIONS}
                getRowId={(revision) => revision.id}
                getRowLabel={(revision) => revision.id}
                loading={revisions.isPending}
                fetching={revisions.isPlaceholderData}
                page={pages.page}
                onPageChange={pages.onPageChange}
                empty={{ title: m.book_history_empty() }}
                skeletonRows={3}
                {...(revisions.isError
                    ? {
                          error: {
                              message: m.book_history_error(),
                              onRetry: () => void revisions.refetch(),
                              retrying: revisions.isFetching,
                          },
                      }
                    : {})}
            />
        </section>
    );
}
