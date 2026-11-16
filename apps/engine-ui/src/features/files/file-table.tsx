import { FILE_SORTS } from '@ptbk/engine-api';
import type { FileMetadata } from '@ptbk/engine-api';
import { createDataTableColumnHelper, DataTable, RelativeTime, useLocale } from '@ptbk/ui';
import type {
    ColumnFiltersState,
    DataTableColumnDef,
    DataTableEmpty,
    DataTablePage,
    DataTableView,
    MenuEntry,
    SortingState,
} from '@ptbk/ui';
import { Bot, CalendarClock, File as FileIcon, HardDrive, ShieldCheck, Tag, Type, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { useBrowser } from '../../app/browser-context';
import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { AgentCreator } from '../agents/agent-creator';
import { PurposeBadge, purposeFilterOptions, ScanBadge, scanFilterOptions } from './file-labels';
import { FileAgent } from './file-origin';
import { formatBytes } from './file-size';
import { FileTypeIcon } from './file-type-icon';
import { DEFAULT_FILE_SORT } from './files-search';
import type { FileSort } from './files-search';
import { useFileScanning } from './use-file-scanning';

const NO_FILES: readonly FileMetadata[] = [];
const SORTABLE: ReadonlySet<string> = new Set(['name', 'sizeBytes', 'createdAt']);
const ICON = 'size-3.5';

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

interface ColumnOptions {
    /** The global list shows each file's agent and filters by purpose; an agent's own tab does neither. */
    readonly global: boolean;
    /** Keep it stable (`useCallback`): a new one rebuilds the columns, and with them every rendered row. */
    readonly nameCell: (file: FileMetadata) => ReactNode;
}

interface ColumnSetup extends ColumnOptions {
    /** A `FilterBar` above the table owns the filters, so the columns offer none of their own. */
    readonly filterBar: boolean;
}

function useFileColumns({ global, nameCell, filterBar }: ColumnSetup): DataTableColumnDef<FileMetadata>[] {
    const formatters = useLocale();
    const scanning = useFileScanning();
    return useMemo(() => {
        const column = createDataTableColumnHelper<FileMetadata>();
        return [
            column.accessor('name', {
                header: m.files_column_name(),
                enableHiding: false,
                meta: { priority: 0, grow: true, icon: <FileIcon className={ICON} /> },
                cell: ({ row }) => (
                    <span className="flex min-w-0 items-start gap-2.5">
                        <FileTypeIcon contentType={row.original.contentType} className="mt-0.5" />
                        <span className="min-w-0">{nameCell(row.original)}</span>
                    </span>
                ),
            }),
            ...(global
                ? [
                      column.accessor('agentId', {
                          header: m.files_column_agent(),
                          enableSorting: false,
                          meta: { priority: 2, icon: <Bot className={ICON} /> },
                          cell: ({ row }) => <FileAgent agentId={row.original.agentId} />,
                      }),
                  ]
                : []),
            column.accessor('purpose', {
                header: m.files_column_purpose(),
                enableSorting: false,
                meta: {
                    priority: 3,
                    icon: <Tag className={ICON} />,
                    ...(global && !filterBar
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
            ...(scanning
                ? [
                      column.accessor((file) => file.scan?.status ?? null, {
                          id: 'scan',
                          header: m.files_column_scan(),
                          enableSorting: false,
                          meta: {
                              priority: 1,
                              icon: <ShieldCheck className={ICON} />,
                              ...(filterBar
                                  ? {}
                                  : {
                                        filter: {
                                            kind: 'select' as const,
                                            allLabel: m.files_filter_all_scans(),
                                            options: scanFilterOptions(),
                                        },
                                    }),
                          },
                          cell: ({ row }) =>
                              row.original.scan === null ? null : <ScanBadge status={row.original.scan.status} />,
                      }),
                  ]
                : []),
            column.accessor('sizeBytes', {
                header: m.files_column_size(),
                sortDescFirst: true,
                meta: { priority: 4, numeric: true, icon: <HardDrive className={ICON} /> },
                cell: ({ row }) => (
                    <span className="whitespace-nowrap text-text-muted tabular-nums">
                        {formatBytes(formatters, row.original.sizeBytes)}
                    </span>
                ),
            }),
            column.accessor('contentType', {
                header: m.files_column_type(),
                enableSorting: false,
                meta: { priority: 6, defaultHidden: true, icon: <Type className={ICON} /> },
                cell: ({ row }) => (
                    <span className="text-sm text-text-muted">
                        <SoftBreaks text={row.original.contentType} after="/+" />
                    </span>
                ),
            }),
            column.accessor('createdBy', {
                header: m.files_column_created_by(),
                enableSorting: false,
                meta: { priority: 7, defaultHidden: true, icon: <UserRound className={ICON} /> },
                cell: ({ row }) => <AgentCreator memberId={row.original.createdBy} />,
            }),
            column.accessor('createdAt', {
                header: m.files_column_created(),
                sortDescFirst: true,
                meta: { priority: 5, trailing: true, numeric: true, icon: <CalendarClock className={ICON} /> },
                cell: ({ row }) => (
                    <RelativeTime
                        value={new Date(row.original.createdAt)}
                        className="whitespace-nowrap text-text-muted"
                    />
                ),
            }),
        ];
    }, [filterBar, formatters, global, nameCell, scanning]);
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
    /** A `FilterBar` above the rows; with it the columns drop their own filter controls. */
    readonly toolbar?: (view: DataTableView) => ReactNode;
}

/** The one file list, server-side: the engine filters, sorts and pages; two-line rows below 768 px come with `DataTable`. */
export function FileTable(props: FileTableProps) {
    const { storage } = useBrowser();
    const columns = useFileColumns({
        global: props.global,
        nameCell: props.nameCell,
        filterBar: props.toolbar !== undefined,
    });
    return (
        <DataTable
            caption={props.caption}
            columns={columns}
            data={props.files ?? NO_FILES}
            getRowId={(file) => file.id}
            getRowLabel={(file) => file.name}
            visibilityStorage={{ storage, key: props.global ? 'ptbk.files.columns' : 'ptbk.agent-files.columns' }}
            sorting={sortingOf(props.sort)}
            onSortingChange={(sorting) => {
                props.onSortChange(sortOf(sorting));
            }}
            sortingRemoval={false}
            columnFilters={props.filters}
            onColumnFiltersChange={props.onFiltersChange}
            page={props.page}
            onPageChange={props.onPageChange}
            {...(props.onPageIntent === undefined ? {} : { onPageIntent: props.onPageIntent })}
            {...(props.toolbar === undefined ? {} : { toolbar: props.toolbar })}
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
