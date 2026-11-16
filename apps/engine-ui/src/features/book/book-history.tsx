import type { AgentId, RevisionId, RevisionSummary } from '@ptbk/engine-api';
import { Button, createDataTableColumnHelper, DataTable, RelativeTime, StatusPill, useLocale } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { AgentCreator } from '../agents/agent-creator';
import { revisionPageQueryOptions, revisionQueryOptions } from './book-queries';
import { countLineChanges } from './line-diff';

const NO_REVISIONS: readonly RevisionSummary[] = [];

/** The version saved just before each one, by ID; null for the first version, absent while unknown. */
type Predecessors = ReadonlyMap<RevisionId, RevisionId | null>;

interface RevisionChangesProps {
    readonly agentId: AgentId;
    readonly revisionId: RevisionId;
    readonly previousId: RevisionId | null | undefined;
}

/**
 * "+3 −1": the lines a version added and removed against the one before, so the rows can be told apart without opening
 * each. Computed here from both texts, which never change once saved, so each is fetched at most once.
 */
function RevisionChanges({ agentId, revisionId, previousId }: RevisionChangesProps) {
    const engineApi = useEngineApi();
    const comparable = previousId !== null && previousId !== undefined;
    const revision = useQuery({ ...revisionQueryOptions(engineApi, agentId, revisionId), enabled: comparable });
    const previous = useQuery({
        ...revisionQueryOptions(engineApi, agentId, previousId ?? revisionId),
        enabled: comparable,
    });
    if (previousId === null) return <span className="text-text-muted">{m.book_history_first()}</span>;
    if (revision.data === undefined || previous.data === undefined) return null;
    const counts = countLineChanges(previous.data.source, revision.data.source);
    if (counts === null) return null;
    if (counts.added === 0 && counts.removed === 0) {
        return <span className="text-text-muted">{m.book_history_no_changes()}</span>;
    }
    return (
        <span className="inline-flex gap-2 font-mono text-sm tabular-nums">
            <span aria-hidden className={counts.added === 0 ? 'text-text-muted' : 'text-success'}>
                +{counts.added}
            </span>
            <span aria-hidden className={counts.removed === 0 ? 'text-text-muted' : 'text-danger'}>
                −{counts.removed}
            </span>
            <span className="sr-only">{m.book_history_changes({ added: counts.added, removed: counts.removed })}</span>
        </span>
    );
}

export interface BookHistoryProps {
    readonly agentId: AgentId;
    readonly currentRevisionId: RevisionId;
    readonly onOpen: (revision: RevisionSummary) => void;
}

function useRevisionColumns(
    agentId: AgentId,
    currentRevisionId: RevisionId,
    predecessors: Predecessors,
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
                        <RelativeTime value={new Date(row.original.createdAt)} className="tabular-nums" />
                        {row.original.id === currentRevisionId ? (
                            <StatusPill tone="success" variant="quiet">
                                {m.book_history_current()}
                            </StatusPill>
                        ) : null}
                    </span>
                ),
            }),
            column.display({
                id: 'changes',
                header: m.book_history_column_changes(),
                meta: { priority: 1 },
                cell: ({ row }) => (
                    <RevisionChanges
                        agentId={agentId}
                        revisionId={row.original.id}
                        previousId={predecessors.get(row.original.id)}
                    />
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
                header: () => <span className="sr-only">{m.book_history_column_version()}</span>,
                enableHiding: false,
                meta: { priority: 0, label: m.book_history_column_version() },
                cell: ({ row }) => (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            onOpen(row.original);
                        }}
                    >
                        {m.book_history_view()}
                    </Button>
                ),
            }),
        ];
    }, [agentId, currentRevisionId, predecessors, onOpen]);
}

/** The book's versions, newest first, a page at a time; opening one shows it read-only, with a diff and restore. */
export function BookHistory({ agentId, currentRevisionId, onOpen }: BookHistoryProps) {
    const engineApi = useEngineApi();
    const [cursor, setCursor] = useState<string | undefined>(undefined);
    const revisions = useQuery({
        ...revisionPageQueryOptions(engineApi, agentId, cursor),
        placeholderData: keepPreviousData,
    });
    const nextCursor = revisions.data?.nextCursor ?? null;
    const pages = useCursorPages(cursor, nextCursor, setCursor);
    // The last row's predecessor heads the next page; asking for that page also gets it ready for "Next".
    const nextPage = useQuery({
        ...revisionPageQueryOptions(engineApi, agentId, nextCursor ?? undefined),
        enabled: nextCursor !== null && !revisions.isPlaceholderData,
    });
    const predecessors = useMemo(() => {
        const items = revisions.isPlaceholderData ? NO_REVISIONS : (revisions.data?.items ?? NO_REVISIONS);
        const older = nextCursor === null ? null : nextPage.data?.items[0]?.id;
        const map = new Map<RevisionId, RevisionId | null>();
        items.forEach((revision, index) => {
            const previous = items[index + 1]?.id ?? older;
            if (previous !== undefined) map.set(revision.id, previous);
        });
        return map;
    }, [revisions.data, revisions.isPlaceholderData, nextCursor, nextPage.data]);
    const columns = useRevisionColumns(agentId, currentRevisionId, predecessors, onOpen);
    const locale = useLocale();

    return (
        <section aria-labelledby="book-history-title" className="flex min-w-0 flex-col gap-1.5">
            <h2 id="book-history-title" className="text-sm font-semibold">
                {m.book_history_title()}
            </h2>
            <DataTable
                caption={m.book_history_title()}
                columns={columns}
                data={revisions.data?.items ?? NO_REVISIONS}
                getRowId={(revision) => revision.id}
                getRowLabel={(revision) =>
                    m.book_revision_title({ savedAt: locale.formatDateTime(new Date(revision.createdAt)) })
                }
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
