import { FILE_SORTS } from '@ptbk/engine-api';
import type { FileMetadata } from '@ptbk/engine-api';
import { createDataTableColumnHelper, DataTable, RelativeTime, useLocale } from '@ptbk/ui';
import type {
    ColumnFiltersState,
    DataTableColumnDef,
    DataTableEmpty,
    DataTablePage,
    MenuEntry,
    SortingState,
} from '@ptbk/ui';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { AgentCreator } from '../agents/agent-creator';
import { PurposeBadge, purposeFilterOptions, ScanBadge, scanFilterOptions } from './file-labels';
import { useFileScanning } from './use-file-scanning';
import { AgentName } from './file-origin';
import { formatBytes } from './file-size';
import { DEFAULT_FILE_SORT } from './files-search';
import type { FileSort } from './files-search';

const NO_FILES: readonly FileMetadata[] = [];
const SORTABLE: ReadonlySet<string> = new Set(['name', 'sizeBytes', 'createdAt']);

export function sortingOf(sort: FileSort): SortingState {
    const desc = sort.startsWith('-');
    return [{ id: desc ? sort.slice(1) : sort, desc }];
}

export function sortOf(sorting: SortingState): FileSort {
    const [first] = sorting;
    if (first === undefined || !SORTABLE.has(first.id)) return DEFAULT_FILE_SORT;
    const sort = `${first.desc ? '-' : ''}${first.id}`;
    return FILE_SORTS.find((candidate) => candidate === sort) ?? DEFAULT_FILE_SORT;
}

export function filterValue(filters: ColumnFiltersState, id: string): string | undefined {
    const value = filters.find((filter) => filter.id === id)?.value;
    return typeof value === 'string' && value !== '' ? value : undefined;
}

interface ColumnOptions {
    /** The global list shows each file's agent and filters by purpose; an agent's own tab does neither. */
    readonly global: boolean;
    /** Keep it stable (`useCallback`): a new one rebuilds the columns, and with them every rendered row. */
    readonly nameCell: (file: FileMetadata) => ReactNode;
}

function useFileColumns({ global, nameCell }: ColumnOptions): DataTableColumnDef<FileMetadata>[] {
    const formatters = useLocale();
    const scanning = useFileScanning();
    return useMemo(() => {
        const column = createDataTableColumnHelper<FileMetadata>();
        return [
            column.accessor('name', {
                header: m.files_column_name(),
                enableHiding: false,
                meta: { priority: 0 },
                cell: ({ row }) => nameCell(row.original),
            }),
            column.accessor('purpose', {
                header: m.files_column_purpose(),
                enableSorting: false,
                meta: {
                    priority: 2,
                    ...(global
                        ? {
                              filter: {
                                  kind: 'select' as const,
                                  allLabel: m.files_filter_all_purposes(),
                                  options: purposeFilterOptions(),
                              },
                          }
                        : {}),
                },
                cell: ({ row }) => <PurposeBadge purpose={row.original.purpose} />,
            }),
            ...(global
                ? [
                      column.accessor('agentId', {
                          header: m.files_column_agent(),
                          enableSorting: false,
                          meta: { priority: 3 },
                          cell: ({ row }) => <AgentName agentId={row.original.agentId} />,
                      }),
                  ]
                : []),
            column.accessor('sizeBytes', {
                header: m.files_column_size(),
                sortDescFirst: true,
                meta: { priority: 4 },
                cell: ({ row }) => (
                    <span className="whitespace-nowrap tabular-nums">
                        {formatBytes(formatters, row.original.sizeBytes)}
                    </span>
                ),
            }),
            column.accessor('contentType', {
                header: m.files_column_type(),
                enableSorting: false,
                meta: { priority: 6 },
                cell: ({ row }) => (
                    <span className="text-sm text-text-muted">
                        <SoftBreaks text={row.original.contentType} after="/+" />
                    </span>
                ),
            }),
            ...(scanning
                ? [
                      column.accessor((file) => file.scan?.status ?? null, {
                          id: 'scan',
                          header: m.files_column_scan(),
                          enableSorting: false,
                          meta: {
                              priority: 1,
                              filter: {
                                  kind: 'select',
                                  allLabel: m.files_filter_all_scans(),
                                  options: scanFilterOptions(),
                              },
                          },
                          cell: ({ row }) =>
                              row.original.scan === null ? null : <ScanBadge status={row.original.scan.status} />,
                      }),
                  ]
                : []),
            column.accessor('createdBy', {
                header: m.files_column_created_by(),
                enableSorting: false,
                meta: { priority: 7 },
                cell: ({ row }) => <AgentCreator memberId={row.original.createdBy} />,
            }),
            column.accessor('createdAt', {
                header: m.files_column_created(),
                sortDescFirst: true,
                meta: { priority: 5 },
                cell: ({ row }) => <RelativeTime value={new Date(row.original.createdAt)} />,
            }),
        ];
    }, [formatters, global, nameCell, scanning]);
}

export interface FileTableProps extends ColumnOptions {
    readonly caption: string;
    readonly files: readonly FileMetadata[] | undefined;
    readonly sort: FileSort;
    readonly onSortChange: (sort: FileSort) => void;
    readonly filters: ColumnFiltersState;
    readonly onFiltersChange: (filters: ColumnFiltersState) => void;
    readonly page: DataTablePage;
    readonly onPageChange: (cursor: string, direction: 'previous' | 'next') => void;
    readonly onPageIntent?: (cursor: string, direction: 'previous' | 'next') => void;
    readonly loading: boolean;
    readonly fetching: boolean;
    readonly error: { readonly onRetry: () => void; readonly retrying: boolean } | null;
    readonly empty: DataTableEmpty;
    readonly rowActions?: (file: FileMetadata) => readonly MenuEntry[];
}

/** The one file list, server-side: the engine filters, sorts and pages; cards below 768 px come with `DataTable`. */
export function FileTable(props: FileTableProps) {
    const columns = useFileColumns({ global: props.global, nameCell: props.nameCell });
    return (
        <DataTable
            caption={props.caption}
            columns={columns}
            data={props.files ?? NO_FILES}
            getRowId={(file) => file.id}
            getRowLabel={(file) => file.name}
            sorting={sortingOf(props.sort)}
            onSortingChange={(sorting) => {
                props.onSortChange(sortOf(sorting));
            }}
            columnFilters={props.filters}
            onColumnFiltersChange={props.onFiltersChange}
            page={props.page}
            onPageChange={props.onPageChange}
            {...(props.onPageIntent === undefined ? {} : { onPageIntent: props.onPageIntent })}
            loading={props.loading}
            fetching={props.fetching}
            {...(props.error === null
                ? {}
                : {
                      error: {
                          message: m.files_load_failed(),
                          onRetry: props.error.onRetry,
                          retrying: props.error.retrying,
                      },
                  })}
            empty={props.empty}
            {...(props.rowActions === undefined ? {} : { rowActions: props.rowActions })}
        />
    );
}
