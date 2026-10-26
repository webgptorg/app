import { functionalUpdate, useTable } from '@tanstack/react-table';
import type {
    Cell,
    Column,
    ColumnFiltersState,
    ColumnVisibilityState,
    Header,
    Row,
    RowData,
    RowSelectionState,
    SortingState,
    Updater,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, Columns3, Ellipsis } from 'lucide-react';
import { Fragment, useCallback, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { Button } from '../button/button';
import { Checkbox } from '../checkbox/checkbox';
import { EmptyState } from '../empty-state/empty-state';
import { ErrorState } from '../error-state/error-state';
import { Field } from '../field/field';
import { IconButton } from '../icon-button/icon-button';
import { Input } from '../input/input';
import { Menu } from '../menu/menu';
import type { MenuEntry } from '../menu/menu';
import { Pagination } from '../pagination/pagination';
import { Select } from '../select/select';
import { Skeleton } from '../skeleton/skeleton';
import { dataTableFeatures } from './columns';
import type { DataTableColumnDef, DataTableColumnFilter, DataTableFeatures } from './columns';
import { useNarrow } from './use-narrow';
import { useRowWindow } from './use-row-window';
import { persistColumnVisibility, readColumnVisibility } from './visibility-storage';
import type { DataTableStorage } from './visibility-storage';

/** Cursor pagination as the engine API pages: opaque cursors, `null` at either end. */
export interface DataTablePage {
    readonly previousCursor: string | null;
    readonly nextCursor: string | null;
    readonly total?: number;
}

export interface DataTableEmpty {
    readonly title: string;
    readonly description?: ReactNode;
    readonly action?: ReactNode;
}

export interface DataTableError {
    readonly message: string;
    readonly onRetry?: () => void;
    readonly retrying?: boolean;
    readonly details?: string;
}

export interface DataTableSelection<TData extends RowData> {
    readonly rowSelection: RowSelectionState;
    readonly onRowSelectionChange: (rowSelection: RowSelectionState) => void;
    readonly canSelect?: (row: TData) => boolean;
}

export interface DataTableExpansion<TData extends RowData> {
    readonly expanded: Readonly<Record<string, boolean>>;
    readonly onExpandedChange: (expanded: Record<string, boolean>) => void;
    readonly renderExpanded: (row: TData) => ReactNode;
    readonly canExpand?: (row: TData) => boolean;
}

export interface DataTableProps<TData extends RowData> {
    /** Names the table for assistive technology; visible only with `showCaption`. */
    readonly caption: string;
    readonly showCaption?: boolean;
    readonly columns: readonly DataTableColumnDef<TData>[];
    /** Keep the reference stable between changes (e.g. straight from the query result). */
    readonly data: readonly TData[];
    readonly getRowId: (row: TData) => string;
    /** A short name for the row in control labels ("Select Lead bot", "Actions for Lead bot"). */
    readonly getRowLabel: (row: TData) => string;
    /**
     * `server` (default): sorting, filters and pages are the app's state (bind them to search params) and the rows
     * arrive already processed; the table never reorders or filters them. `client`: for small, fully loaded lists.
     */
    readonly mode?: 'server' | 'client';
    readonly sorting?: SortingState;
    readonly onSortingChange?: (sorting: SortingState) => void;
    readonly columnFilters?: ColumnFiltersState;
    readonly onColumnFiltersChange?: (columnFilters: ColumnFiltersState) => void;
    readonly columnVisibility?: ColumnVisibilityState;
    readonly onColumnVisibilityChange?: (columnVisibility: ColumnVisibilityState) => void;
    /** Remembers hidden columns per device when `columnVisibility` is not controlled. */
    readonly visibilityStorage?: { readonly storage: DataTableStorage | undefined; readonly key: string };
    readonly page?: DataTablePage;
    /** Called with the cursor to load: `page.previousCursor` or `page.nextCursor`. */
    readonly onPageChange?: (cursor: string, direction: 'previous' | 'next') => void;
    /** The reader is about to change page (hover or focus on previous or next), so the app can prefetch it. */
    readonly onPageIntent?: (cursor: string, direction: 'previous' | 'next') => void;
    /** First load: skeleton rows of stable height. */
    readonly loading?: boolean;
    /** A later load (next page, new sort): the current rows stay visible, dimmed. */
    readonly fetching?: boolean;
    readonly error?: DataTableError;
    /** What an empty list says; defaults to `UiMessages.noData`. */
    readonly empty?: DataTableEmpty;
    readonly selection?: DataTableSelection<TData>;
    readonly expansion?: DataTableExpansion<TData>;
    readonly rowActions?: (row: TData) => readonly MenuEntry[];
    /** Above this many rows only the visible window is mounted. */
    readonly virtualizeAbove?: number;
    /** Estimated row height in px, for virtualisation and skeleton rows. */
    readonly rowHeight?: number;
    readonly skeletonRows?: number;
}

const DEFAULT_VIRTUALIZE_ABOVE = 100;
/** A list this short is read at a glance; hiding its columns only adds a control nobody needs. */
export const COLUMN_MENU_MIN_ROWS = 6;
const DEFAULT_ROW_HEIGHT = 48;
const NO_SORTING: SortingState = [];
const NO_FILTERS: ColumnFiltersState = [];

type TableRow<TData extends RowData> = Row<DataTableFeatures, TData>;
type TableColumn<TData extends RowData> = Column<DataTableFeatures, TData>;

/** A controlled value when the prop is given, otherwise local state; changes always reach `onChange`. */
function useControllable<T>(value: T | undefined, onChange: ((next: T) => void) | undefined, initial: () => T) {
    const [local, setLocal] = useState(initial);
    const current = value ?? local;
    const update = useCallback(
        (updater: Updater<T>) => {
            const next = functionalUpdate(updater, current);
            if (value === undefined) setLocal(next);
            onChange?.(next);
        },
        [current, value, onChange],
    );
    return [current, update] as const;
}

export function columnLabel<TData extends RowData>(column: TableColumn<TData>): string {
    const meta = column.columnDef.meta;
    if (meta?.label !== undefined) return meta.label;
    return typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id;
}

function hasActiveFilter(filters: ColumnFiltersState): boolean {
    return filters.some(({ value }) => value !== undefined && value !== '' && value !== null);
}

/** Paging controls only mean something when there is another page to go to. */
export function hasOtherPages(page: DataTablePage | undefined): page is DataTablePage {
    return page !== undefined && (page.previousCursor !== null || page.nextCursor !== null);
}

export interface ColumnMenuInput {
    readonly hideableColumns: number;
    readonly hiddenColumns: number;
    readonly rows: number;
    readonly paged: boolean;
    readonly filtered: boolean;
}

/**
 * The column menu earns its place on a long or paged list. It also stays while a column is hidden, so the reader can
 * bring it back, and while a filter narrows the list, so it does not blink away as results shrink.
 */
export function wantsColumnMenu({ hideableColumns, hiddenColumns, rows, paged, filtered }: ColumnMenuInput): boolean {
    if (hideableColumns === 0) return false;
    return hiddenColumns > 0 || paged || filtered || rows >= COLUMN_MENU_MIN_ROWS;
}

/**
 * The one table for every list (ADR 0007): real `<table>` semantics with sortable headers, filters, column visibility,
 * selection, expansion, row actions and cursor paging, built-in loading, empty, no-results and error states,
 * virtualisation for long lists, and cards below 768 px so a table never scrolls the page sideways.
 */
export function DataTable<TData extends RowData>(props: DataTableProps<TData>) {
    const {
        caption,
        showCaption = false,
        columns,
        data,
        getRowId,
        getRowLabel,
        mode = 'server',
        page,
        onPageChange,
        onPageIntent,
        loading = false,
        fetching = false,
        error,
        empty,
        selection,
        expansion,
        rowActions,
        virtualizeAbove = DEFAULT_VIRTUALIZE_ABOVE,
        rowHeight = DEFAULT_ROW_HEIGHT,
        skeletonRows = 5,
        visibilityStorage,
    } = props;
    const messages = useUiMessages();
    const narrow = useNarrow();
    const scrollRef = useRef<HTMLDivElement>(null);
    const captionId = useId();

    const [sorting, setSorting] = useControllable(props.sorting, props.onSortingChange, () => NO_SORTING);
    const [columnFilters, setColumnFilters] = useControllable(
        props.columnFilters,
        props.onColumnFiltersChange,
        () => NO_FILTERS,
    );
    const onVisibility = props.onColumnVisibilityChange;
    const persistVisibility = useCallback(
        (next: ColumnVisibilityState) => {
            if (visibilityStorage !== undefined && props.columnVisibility === undefined) {
                persistColumnVisibility(visibilityStorage.storage, visibilityStorage.key, next);
            }
            onVisibility?.(next);
        },
        [visibilityStorage, props.columnVisibility, onVisibility],
    );
    const [columnVisibility, setColumnVisibility] = useControllable(props.columnVisibility, persistVisibility, () =>
        visibilityStorage === undefined ? {} : readColumnVisibility(visibilityStorage.storage, visibilityStorage.key),
    );

    const rowSelection = selection?.rowSelection;
    const onRowSelection = selection?.onRowSelectionChange;
    const setRowSelection = useCallback(
        (updater: Updater<RowSelectionState>) => onRowSelection?.(functionalUpdate(updater, rowSelection ?? {})),
        [rowSelection, onRowSelection],
    );
    const expanded = expansion?.expanded;
    const onExpanded = expansion?.onExpandedChange;
    const setExpanded = useCallback(
        (updater: Updater<true | Record<string, boolean>>) => {
            const next = functionalUpdate(updater, { ...expanded });
            // `true` means "everything"; this table only ever expands rows one by one, so it never asks for it.
            if (next !== true) onExpanded?.(next);
        },
        [expanded, onExpanded],
    );
    const canSelect = selection?.canSelect;
    const canExpand = expansion?.canExpand;

    const table = useTable<DataTableFeatures, TData>({
        features: dataTableFeatures,
        columns,
        data,
        getRowId: (row) => getRowId(row),
        state: {
            sorting,
            columnFilters,
            columnVisibility,
            rowSelection: rowSelection ?? {},
            expanded: { ...expanded },
        },
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        onColumnVisibilityChange: setColumnVisibility,
        onRowSelectionChange: setRowSelection,
        onExpandedChange: setExpanded,
        manualSorting: mode === 'server',
        manualFiltering: mode === 'server',
        enableRowSelection: selection === undefined ? false : (row) => canSelect?.(row.original) ?? true,
        getRowCanExpand: (row) => expansion !== undefined && (canExpand?.(row.original) ?? true),
    });

    const rows = table.getRowModel().rows;
    const visibleColumns = table.getVisibleLeafColumns();
    const filterColumns = table.getAllLeafColumns().flatMap((column) => {
        const filter = column.columnDef.meta?.filter;
        return filter === undefined ? [] : [{ column, filter }];
    });
    const hideableColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());
    const paged = hasOtherPages(page);
    const columnMenuWanted = wantsColumnMenu({
        hideableColumns: hideableColumns.length,
        hiddenColumns: hideableColumns.filter((column) => !column.getIsVisible()).length,
        rows: rows.length,
        paged,
        filtered: hasActiveFilter(columnFilters),
    });
    // Once shown it stays: a server-side filter or search outside the table can shrink the rows at any time.
    const [columnMenuShown, setColumnMenuShown] = useState(columnMenuWanted);
    if (columnMenuWanted && !columnMenuShown) setColumnMenuShown(true);
    const showColumnMenu = hideableColumns.length > 0 && !narrow && (columnMenuWanted || columnMenuShown);
    const extraColumns = (selection === undefined ? 0 : 1) + (expansion === undefined ? 0 : 1) + (rowActions ? 1 : 0);
    const columnCount = visibleColumns.length + extraColumns;
    const selectedCount = Object.values(rowSelection ?? {}).filter(Boolean).length;
    const busy = loading || fetching;
    const showSkeleton = loading && rows.length === 0;

    const rowWindow = useRowWindow({
        count: rows.length,
        enabled: !showSkeleton && rows.length > virtualizeAbove,
        rowHeight,
        scrollRef,
        getKey: (index) => rows[index]?.id ?? String(index),
    });

    const rowContext: RowContext<TData> = {
        table,
        selection,
        expansion,
        rowActions,
        getRowLabel,
        columnCount,
        rowHeight: rowWindow.virtual ? rowHeight : undefined,
    };

    const emptyContent = (() => {
        if (showSkeleton || rows.length > 0 || error !== undefined) return null;
        return hasActiveFilter(columnFilters) ? (
            <EmptyState title={messages.noResults()} />
        ) : (
            <EmptyState
                title={empty?.title ?? messages.noData()}
                description={empty?.description}
                action={empty?.action}
            />
        );
    })();

    return (
        <div className="flex min-w-0 flex-col gap-3">
            {filterColumns.length > 0 || showColumnMenu || selection !== undefined ? (
                <div className="flex flex-wrap items-end gap-3">
                    {filterColumns.map(({ column, filter }) => (
                        <ColumnFilterControl key={column.id} column={column} filter={filter} />
                    ))}
                    {selection === undefined ? null : (
                        <p aria-live="polite" className="min-h-5 text-sm text-(--data-table-muted)">
                            {selectedCount > 0 ? messages.selectedCount({ count: selectedCount }) : null}
                        </p>
                    )}
                    {showColumnMenu ? (
                        <div className="ms-auto">
                            <ColumnVisibilityMenu columns={hideableColumns} />
                        </div>
                    ) : null}
                </div>
            ) : null}

            <span role="status" className="sr-only">
                {busy ? messages.loading() : null}
            </span>

            {error === undefined ? null : <ErrorState {...error} />}

            {error !== undefined ? null : narrow ? (
                <div
                    ref={scrollRef}
                    aria-busy={busy || undefined}
                    className={cx(
                        rowWindow.virtual && 'max-h-(--data-table-max-height) overflow-y-auto',
                        fetching && '[filter:var(--data-table-fetching-filter)]',
                    )}
                >
                    {showSkeleton ? (
                        <ul aria-label={caption} className="flex flex-col gap-3">
                            {Array.from({ length: skeletonRows }, (_, index) => (
                                <li key={index} className="rounded-(--data-table-radius) bg-(--data-table-card-bg) p-4">
                                    <Skeleton shape="text" className="h-5 w-1/2" />
                                    <Skeleton shape="text" className="mt-3 h-4 w-3/4" />
                                </li>
                            ))}
                        </ul>
                    ) : rows.length === 0 ? (
                        emptyContent
                    ) : (
                        <ul aria-label={caption} className="flex flex-col gap-3">
                            {rowWindow.paddingBefore > 0 ? (
                                <li aria-hidden="true" style={{ height: rowWindow.paddingBefore }} />
                            ) : null}
                            {rowWindow.indices.map((index) => {
                                const row = rows[index];
                                return row === undefined ? null : (
                                    <RowCard
                                        key={row.id}
                                        row={row}
                                        index={index}
                                        context={rowContext}
                                        measureRef={rowWindow.measure}
                                    />
                                );
                            })}
                            {rowWindow.paddingAfter > 0 ? (
                                <li aria-hidden="true" style={{ height: rowWindow.paddingAfter }} />
                            ) : null}
                        </ul>
                    )}
                </div>
            ) : (
                <div
                    ref={scrollRef}
                    aria-busy={busy || undefined}
                    {...(rowWindow.virtual ? { role: 'region', 'aria-labelledby': captionId, tabIndex: 0 } : {})}
                    className={cx(
                        'overflow-x-auto rounded-(--data-table-radius) border border-(--data-table-border) bg-(--data-table-bg)',
                        rowWindow.virtual && 'max-h-(--data-table-max-height) overflow-y-auto',
                    )}
                >
                    <table
                        className={cx(
                            'w-full border-collapse text-left text-sm text-(--data-table-text)',
                            'motion-safe:transition-opacity motion-safe:duration-(--motion-state) motion-safe:ease-standard',
                            fetching && '[filter:var(--data-table-fetching-filter)]',
                        )}
                    >
                        <caption
                            id={captionId}
                            className={showCaption ? 'pb-2 text-left font-display text-lg font-semibold' : 'sr-only'}
                        >
                            {caption}
                        </caption>
                        <thead className="sticky top-0 z-10 bg-(--data-table-header-bg)">
                            {table.getHeaderGroups().map((group) => (
                                <tr key={group.id}>
                                    {selection === undefined ? null : (
                                        <th scope="col" className="w-10 px-3 py-2">
                                            <Checkbox
                                                aria-label={messages.selectAllOnPage()}
                                                checked={table.getIsAllPageRowsSelected()}
                                                indeterminate={table.getIsSomePageRowsSelected()}
                                                disabled={rows.length === 0}
                                                onChange={table.getToggleAllPageRowsSelectedHandler()}
                                            />
                                        </th>
                                    )}
                                    {expansion === undefined ? null : <td className="w-10 px-1 py-2" />}
                                    {group.headers.map((header) => (
                                        <HeaderCell key={header.id} header={header} table={table} />
                                    ))}
                                    {rowActions === undefined ? null : <td className="w-12 px-1 py-2" />}
                                </tr>
                            ))}
                        </thead>
                        {showSkeleton ? (
                            <tbody>
                                {Array.from({ length: skeletonRows }, (_, index) => (
                                    <tr
                                        key={index}
                                        style={{ height: rowHeight }}
                                        className="border-t border-(--data-table-divider)"
                                    >
                                        {Array.from({ length: columnCount }, (_, cell) => (
                                            <td key={cell} className="px-3 py-2">
                                                <Skeleton shape="text" />
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        ) : rows.length === 0 ? (
                            <tbody>
                                <tr>
                                    <td colSpan={columnCount}>{emptyContent}</td>
                                </tr>
                            </tbody>
                        ) : (
                            <>
                                {rowWindow.paddingBefore > 0 ? (
                                    <tbody aria-hidden="true">
                                        <tr>
                                            <td colSpan={columnCount} style={{ height: rowWindow.paddingBefore }} />
                                        </tr>
                                    </tbody>
                                ) : null}
                                {rowWindow.virtual ? (
                                    rowWindow.indices.map((index) => {
                                        const row = rows[index];
                                        return row === undefined ? null : (
                                            <tbody key={row.id} data-index={index} ref={rowWindow.measure}>
                                                <TableRow row={row} context={rowContext} />
                                            </tbody>
                                        );
                                    })
                                ) : (
                                    <tbody>
                                        {rows.map((row) => (
                                            <TableRow key={row.id} row={row} context={rowContext} />
                                        ))}
                                    </tbody>
                                )}
                                {rowWindow.paddingAfter > 0 ? (
                                    <tbody aria-hidden="true">
                                        <tr>
                                            <td colSpan={columnCount} style={{ height: rowWindow.paddingAfter }} />
                                        </tr>
                                    </tbody>
                                ) : null}
                            </>
                        )}
                    </table>
                </div>
            )}

            {!paged || onPageChange === undefined ? null : (
                <Pagination
                    hasPrevious={page.previousCursor !== null}
                    hasNext={page.nextCursor !== null}
                    onPrevious={() => {
                        if (page.previousCursor !== null) onPageChange(page.previousCursor, 'previous');
                    }}
                    onNext={() => {
                        if (page.nextCursor !== null) onPageChange(page.nextCursor, 'next');
                    }}
                    {...(onPageIntent === undefined
                        ? {}
                        : {
                              onPreviousIntent: () => {
                                  if (page.previousCursor !== null) onPageIntent(page.previousCursor, 'previous');
                              },
                              onNextIntent: () => {
                                  if (page.nextCursor !== null) onPageIntent(page.nextCursor, 'next');
                              },
                          })}
                    {...(page.total === undefined ? {} : { total: page.total })}
                    disabled={busy}
                />
            )}
        </div>
    );
}

type DataTableInstance<TData extends RowData> = ReturnType<typeof useTable<DataTableFeatures, TData>>;

interface RowContext<TData extends RowData> {
    readonly table: DataTableInstance<TData>;
    readonly selection: DataTableSelection<TData> | undefined;
    readonly expansion: DataTableExpansion<TData> | undefined;
    readonly rowActions: ((row: TData) => readonly MenuEntry[]) | undefined;
    readonly getRowLabel: (row: TData) => string;
    readonly columnCount: number;
    /** Fixed height for virtualised rows. */
    readonly rowHeight: number | undefined;
}

function HeaderCell<TData extends RowData>({
    header,
    table,
}: {
    readonly header: Header<DataTableFeatures, TData>;
    readonly table: DataTableInstance<TData>;
}) {
    const messages = useUiMessages();
    const { column } = header;
    const content = header.isPlaceholder ? null : <table.FlexRender header={header} />;
    if (!column.getCanSort()) {
        return (
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-(--data-table-header-text)">
                {content}
            </th>
        );
    }
    const sorted = column.getIsSorted();
    const label = columnLabel(column);
    const name =
        sorted === false
            ? messages.sortBy({ column: label })
            : `${label}, ${sorted === 'asc' ? messages.sortAscending() : messages.sortDescending()}`;
    const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
    return (
        <th
            scope="col"
            aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
            className="px-1 py-1 font-medium whitespace-nowrap text-(--data-table-header-text)"
        >
            <button
                type="button"
                aria-label={name}
                onClick={column.getToggleSortingHandler()}
                className="inline-flex cursor-pointer items-center gap-1 rounded-small px-2 py-1 hover:bg-(--data-table-row-hover) motion-safe:transition-colors motion-safe:duration-(--motion-state)"
            >
                {content}
                <Icon aria-hidden="true" className={cx('size-3.5', sorted === false && 'text-(--data-table-muted)')} />
            </button>
        </th>
    );
}

function SelectRowCheckbox<TData extends RowData>({
    row,
    context,
}: {
    readonly row: TableRow<TData>;
    readonly context: RowContext<TData>;
}) {
    const messages = useUiMessages();
    return (
        <Checkbox
            aria-label={messages.selectRow({ label: context.getRowLabel(row.original) })}
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onChange={row.getToggleSelectedHandler()}
        />
    );
}

function ExpandButton<TData extends RowData>({
    row,
    context,
    detailId,
}: {
    readonly row: TableRow<TData>;
    readonly context: RowContext<TData>;
    readonly detailId: string;
}) {
    const messages = useUiMessages();
    if (!row.getCanExpand()) return null;
    const isExpanded = row.getIsExpanded();
    const label = context.getRowLabel(row.original);
    return (
        <IconButton
            variant="ghost"
            size="sm"
            label={isExpanded ? messages.collapseRow({ label }) : messages.expandRow({ label })}
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? detailId : undefined}
            icon={
                <ChevronRight
                    aria-hidden="true"
                    className={cx(
                        'size-4 motion-safe:transition-transform motion-safe:duration-(--motion-state)',
                        isExpanded && 'rotate-90',
                    )}
                />
            }
            onClick={() => {
                row.toggleExpanded();
            }}
        />
    );
}

function RowActionsMenu<TData extends RowData>({
    row,
    context,
}: {
    readonly row: TableRow<TData>;
    readonly context: RowContext<TData>;
}) {
    const messages = useUiMessages();
    if (context.rowActions === undefined) return null;
    const items = context.rowActions(row.original);
    if (items.length === 0) return null;
    const label = messages.rowActions({ label: context.getRowLabel(row.original) });
    return (
        <Menu
            label={label}
            align="end"
            items={items}
            trigger={(triggerProps) => (
                <IconButton
                    {...triggerProps}
                    variant="ghost"
                    size="sm"
                    label={label}
                    icon={<Ellipsis aria-hidden="true" className="size-4" />}
                />
            )}
        />
    );
}

function TableRow<TData extends RowData>({
    row,
    context,
}: {
    readonly row: TableRow<TData>;
    readonly context: RowContext<TData>;
}) {
    const detailId = useId();
    const { selection, expansion, rowActions, table } = context;
    const isExpanded = expansion !== undefined && row.getIsExpanded();
    return (
        <>
            <tr
                aria-selected={selection === undefined ? undefined : row.getIsSelected()}
                style={context.rowHeight === undefined ? undefined : { height: context.rowHeight }}
                className={cx(
                    'border-t border-(--data-table-divider) hover:bg-(--data-table-row-hover)',
                    row.getIsSelected() && 'bg-(--data-table-row-selected)',
                )}
            >
                {selection === undefined ? null : (
                    <td className="px-3 py-2">
                        <SelectRowCheckbox row={row} context={context} />
                    </td>
                )}
                {expansion === undefined ? null : (
                    <td className="px-1 py-2">
                        <ExpandButton row={row} context={context} detailId={detailId} />
                    </td>
                )}
                {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-middle">
                        <table.FlexRender cell={cell} />
                    </td>
                ))}
                {rowActions === undefined ? null : (
                    <td className="px-1 py-2 text-right">
                        <RowActionsMenu row={row} context={context} />
                    </td>
                )}
            </tr>
            {isExpanded ? (
                <tr id={detailId} className="bg-(--data-table-expanded-bg)">
                    <td colSpan={context.columnCount} className="px-4 py-3">
                        {expansion.renderExpanded(row.original)}
                    </td>
                </tr>
            ) : null}
        </>
    );
}

function cardColumns<TData extends RowData>(cells: readonly Cell<DataTableFeatures, TData>[]) {
    return cells
        .filter((cell) => cell.column.columnDef.meta?.hideOnCard !== true)
        .map((cell, order) => ({
            cell,
            order,
            priority: cell.column.columnDef.meta?.priority ?? Number.MAX_SAFE_INTEGER,
        }))
        .sort((a, b) => a.priority - b.priority || a.order - b.order)
        .map(({ cell }) => cell);
}

function RowCard<TData extends RowData>({
    row,
    index,
    context,
    measureRef,
}: {
    readonly row: TableRow<TData>;
    readonly index: number;
    readonly context: RowContext<TData>;
    readonly measureRef: (element: Element | null) => void;
}) {
    const detailId = useId();
    const titleId = useId();
    const { selection, expansion, table } = context;
    const [title, ...rest] = cardColumns(row.getVisibleCells());
    const isExpanded = expansion !== undefined && row.getIsExpanded();
    return (
        <li
            data-index={index}
            ref={measureRef}
            aria-labelledby={titleId}
            className={cx(
                'flex flex-col gap-3 rounded-(--data-table-radius) border border-(--data-table-border) bg-(--data-table-card-bg) p-4',
                row.getIsSelected() && 'border-(--data-table-card-selected-border) bg-(--data-table-row-selected)',
            )}
        >
            <div className="flex items-start gap-2">
                {selection === undefined ? null : (
                    <span className="flex min-h-6 items-center">
                        <SelectRowCheckbox row={row} context={context} />
                    </span>
                )}
                <div id={titleId} className="min-w-0 flex-1 font-medium break-words">
                    {title === undefined ? context.getRowLabel(row.original) : <table.FlexRender cell={title} />}
                </div>
                {expansion === undefined ? null : <ExpandButton row={row} context={context} detailId={detailId} />}
                <RowActionsMenu row={row} context={context} />
            </div>
            {rest.length === 0 ? null : (
                <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                    {rest.map((cell) => (
                        <Fragment key={cell.id}>
                            <dt className="text-(--data-table-muted)">{columnLabel(cell.column)}</dt>
                            <dd className="min-w-0 break-words">
                                <table.FlexRender cell={cell} />
                            </dd>
                        </Fragment>
                    ))}
                </dl>
            )}
            {isExpanded ? (
                <div id={detailId} className="border-t border-(--data-table-divider) pt-3">
                    {expansion.renderExpanded(row.original)}
                </div>
            ) : null}
        </li>
    );
}

function ColumnFilterControl<TData extends RowData>({
    column,
    filter,
}: {
    readonly column: TableColumn<TData>;
    readonly filter: DataTableColumnFilter;
}) {
    const value = column.getFilterValue();
    const current = typeof value === 'string' ? value : '';
    const set = (next: string) => {
        column.setFilterValue(next === '' ? undefined : next);
    };
    return (
        <Field label={columnLabel(column)} className="w-full sm:w-56">
            {(control) =>
                filter.kind === 'text' ? (
                    <Input
                        {...control}
                        type="search"
                        value={current}
                        {...(filter.placeholder === undefined ? {} : { placeholder: filter.placeholder })}
                        onChange={(event) => {
                            set(event.target.value);
                        }}
                    />
                ) : (
                    <Select
                        {...control}
                        value={current}
                        onChange={(event) => {
                            set(event.target.value);
                        }}
                    >
                        <option value="">{filter.allLabel}</option>
                        {filter.options.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </Select>
                )
            }
        </Field>
    );
}

function ColumnVisibilityMenu<TData extends RowData>({ columns }: { readonly columns: readonly TableColumn<TData>[] }) {
    const messages = useUiMessages();
    const visible = columns.filter((column) => column.getIsVisible());
    const items: MenuEntry[] = columns.map((column) => ({
        kind: 'item',
        id: column.id,
        label: columnLabel(column),
        checked: column.getIsVisible(),
        checkable: 'checkbox',
        // The last visible column stays: a table without columns explains nothing.
        disabled: visible.length === 1 && column.getIsVisible(),
        onSelect: () => {
            column.toggleVisibility();
        },
    }));
    return (
        <Menu
            label={messages.columns()}
            align="end"
            items={items}
            trigger={(triggerProps) => (
                <Button {...triggerProps} size="sm">
                    <Columns3 aria-hidden="true" className="size-4" />
                    {messages.columns()}
                </Button>
            )}
        />
    );
}
