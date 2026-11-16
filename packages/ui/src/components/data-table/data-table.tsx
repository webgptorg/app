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
import { useCallback, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { useScrollEdges } from '../../internal/scroll-edges';
import { Button } from '../button/button';
import { Checkbox } from '../checkbox/checkbox';
import { EmptyState } from '../empty-state/empty-state';
import type { FilterBarColumns, FilterBarSort } from '../filter-bar/filter-bar';
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
    /**
     * The bar above the rows, usually a `FilterBar`: it gets the table's sort and column visibility to mirror, so
     * `toolbar={(view) => <FilterBar {...view} fields={…} />}` puts Sort and Columns in the bar instead of a row of
     * their own.
     */
    readonly toolbar?: (view: DataTableView) => ReactNode;
    /** Splits the rows under group headers (e.g. Now, Coming up, Done) with counts, keeping their order within a group. */
    readonly groups?: DataTableGrouping<TData>;
    /** `false` for a list that always has an order (e.g. newest first): a sorted header then flips instead of clearing. */
    readonly sortingRemoval?: boolean;
}

/** What `DataTable` hands its toolbar: present only when the table has something to offer. */
export interface DataTableView {
    readonly sort?: FilterBarSort;
    readonly columns?: FilterBarColumns;
}

export interface DataTableGroup {
    readonly id: string;
    readonly label: string;
}

export interface DataTableGrouping<TData extends RowData> {
    /** In display order; a group without rows is left out. */
    readonly groups: readonly DataTableGroup[];
    readonly getGroupId: (row: TData) => string;
}

const DEFAULT_VIRTUALIZE_ABOVE = 100;
/** A list this short is read at a glance; hiding its columns only adds a control nobody needs. */
export const COLUMN_MENU_MIN_ROWS = 6;
/** One or two rows have no order worth choosing; sort buttons there are only noise and extra Tab stops. */
export const SORT_MIN_ROWS = 3;
const DEFAULT_ROW_HEIGHT = 40;
const NO_SORTING: SortingState = [];
const NO_FILTERS: ColumnFiltersState = [];

/** A fade where the scroller hides columns, so a reader sees there is more to scroll to. */
const FADE_CLASSES = {
    left: '[mask-image:linear-gradient(to_left,#000_calc(100%-var(--data-table-fade)),transparent)]',
    right: '[mask-image:linear-gradient(to_right,#000_calc(100%-var(--data-table-fade)),transparent)]',
    both: '[mask-image:linear-gradient(to_right,transparent,#000_var(--data-table-fade),#000_calc(100%-var(--data-table-fade)),transparent)]',
} as const;

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

/** Columns marked `defaultHidden` start hidden; what the reader chose and stored wins. */
export function initialColumnVisibility<TData extends RowData>(
    columns: readonly DataTableColumnDef<TData>[],
    stored: ColumnVisibilityState,
): ColumnVisibilityState {
    const hidden: Record<string, boolean> = {};
    for (const column of columns) {
        const id = column.id ?? ('accessorKey' in column ? String(column.accessorKey) : undefined);
        if (column.meta?.defaultHidden === true && column.enableHiding !== false && id !== undefined)
            hidden[id] = false;
    }
    return { ...hidden, ...stored };
}

/** Paging controls only mean something when there is another page to go to. */
export function hasOtherPages(page: DataTablePage | undefined): page is DataTablePage {
    return page !== undefined && (page.previousCursor !== null || page.nextCursor !== null);
}

export interface SortingInput {
    readonly sortableColumns: number;
    readonly rows: number;
    readonly paged: boolean;
    readonly sorted: boolean;
    readonly filtered: boolean;
}

/**
 * Sort buttons earn their place on a list of a few rows or more, or a paged one. They also stay while a sort is
 * applied, so the reader can undo it, and while a filter narrows the list.
 */
export function wantsSorting({ sortableColumns, rows, paged, sorted, filtered }: SortingInput): boolean {
    if (sortableColumns === 0) return false;
    return sorted || paged || filtered || rows >= SORT_MIN_ROWS;
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

type TableItem<TData extends RowData> =
    | { readonly kind: 'group'; readonly id: string; readonly label: string; readonly count: number }
    | { readonly kind: 'row'; readonly row: TableRow<TData> };

/** The rows as one flat list, with a header item before each non-empty group, so virtualisation sees one sequence. */
export function tableItems<TData extends RowData>(
    rows: readonly TableRow<TData>[],
    grouping: DataTableGrouping<TData> | undefined,
): readonly TableItem<TData>[] {
    if (grouping === undefined) return rows.map((row) => ({ kind: 'row', row }));
    const byGroup = new Map<string, TableRow<TData>[]>(grouping.groups.map((group) => [group.id, []]));
    for (const row of rows) byGroup.get(grouping.getGroupId(row.original))?.push(row);
    return grouping.groups.flatMap((group): TableItem<TData>[] => {
        const members = byGroup.get(group.id) ?? [];
        if (members.length === 0) return [];
        return [
            { kind: 'group', id: group.id, label: group.label, count: members.length },
            ...members.map((row): TableItem<TData> => ({ kind: 'row', row })),
        ];
    });
}

/**
 * The one table for every list (ADR 0007): real `<table>` semantics with sortable headers, filters, column visibility,
 * selection, expansion, row actions, group headers and cursor paging, built-in loading, empty, no-results and error
 * states, and virtualisation for long lists. Rows are quiet: hairlines, no zebra, actions on hover. Below 768 px each
 * row becomes a two-line item, so a table never scrolls the page sideways.
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
        toolbar,
        groups,
        sortingRemoval = true,
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
        initialColumnVisibility(
            columns,
            visibilityStorage === undefined
                ? {}
                : readColumnVisibility(visibilityStorage.storage, visibilityStorage.key),
        ),
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
        enableSortingRemoval: sortingRemoval,
        enableRowSelection: selection === undefined ? false : (row) => canSelect?.(row.original) ?? true,
        getRowCanExpand: (row) => expansion !== undefined && (canExpand?.(row.original) ?? true),
    });

    const rows = table.getRowModel().rows;
    const items = tableItems(rows, groups);
    const visibleColumns = table.getVisibleLeafColumns();
    const filterColumns = table.getAllLeafColumns().flatMap((column) => {
        const filter = column.columnDef.meta?.filter;
        return filter === undefined ? [] : [{ column, filter }];
    });
    const hideableColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());
    const sortableColumns = table.getAllLeafColumns().filter((column) => column.getCanSort());
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
    const sortingWanted = wantsSorting({
        sortableColumns: sortableColumns.length,
        rows: data.length,
        paged,
        sorted: sorting.length > 0,
        filtered: hasActiveFilter(columnFilters),
    });
    // Like the column menu, it stays once shown: the headers do not change under the reader as the list shrinks.
    const [sortingShown, setSortingShown] = useState(sortingWanted);
    if (sortingWanted && !sortingShown) setSortingShown(true);
    const showSorting = sortingWanted || sortingShown;
    const extraColumns = (selection === undefined ? 0 : 1) + (expansion === undefined ? 0 : 1) + (rowActions ? 1 : 0);
    const columnCount = visibleColumns.length + extraColumns;
    const selectedCount = Object.values(rowSelection ?? {}).filter(Boolean).length;
    const busy = loading || fetching;
    const showSkeleton = loading && rows.length === 0;

    const rowWindow = useRowWindow({
        count: items.length,
        enabled: !showSkeleton && items.length > virtualizeAbove,
        rowHeight,
        scrollRef,
        getKey: (index) => {
            const item = items[index];
            return item === undefined ? String(index) : item.kind === 'group' ? `group:${item.id}` : item.row.id;
        },
    });

    const edges = useScrollEdges(
        scrollRef,
        undefined,
        `${String(rows.length)}:${String(columnCount)}:${String(narrow)}`,
    );
    const overflowing = edges.left || edges.right;
    const fade = edges.left && edges.right ? 'both' : edges.left ? 'left' : edges.right ? 'right' : null;

    const rowContext: RowContext<TData> = {
        table,
        selection,
        expansion,
        rowActions,
        getRowLabel,
        columnCount,
        rowHeight: rowWindow.virtual ? rowHeight : undefined,
    };

    const visibleCount = hideableColumns.filter((column) => column.getIsVisible()).length;
    const firstSort = sorting[0];
    const view: DataTableView = {
        ...(showSorting && sortableColumns.length > 0
            ? {
                  sort: {
                      options: sortableColumns.map((column) => ({ id: column.id, label: columnLabel(column) })),
                      value: firstSort === undefined ? undefined : { id: firstSort.id, desc: firstSort.desc },
                      onChange: (next) => {
                          setSorting([{ id: next.id, desc: next.desc }]);
                      },
                  },
              }
            : {}),
        ...(hideableColumns.length > 0 && !narrow
            ? {
                  columns: {
                      items: hideableColumns.map((column) => ({
                          id: column.id,
                          label: columnLabel(column),
                          visible: column.getIsVisible(),
                          // The last visible column stays: a table without columns explains nothing.
                          disabled: visibleCount === 1 && column.getIsVisible(),
                      })),
                      onToggle: (id) => {
                          table.getColumn(id)?.toggleVisibility();
                      },
                  },
              }
            : {}),
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

    const selectionStatus =
        selection === undefined ? null : (
            <p aria-live="polite" className="min-h-5 text-xs text-(--data-table-muted) tabular-nums">
                {selectedCount > 0 ? messages.selectedCount({ count: selectedCount }) : null}
            </p>
        );
    const legacyControls = filterColumns.length > 0 || (toolbar === undefined && showColumnMenu);

    return (
        <div className="flex min-w-0 flex-col gap-2">
            {toolbar === undefined ? null : toolbar(view)}
            {legacyControls || selection !== undefined ? (
                <div className="flex flex-wrap items-end gap-3">
                    {filterColumns.map(({ column, filter }) => (
                        <ColumnFilterControl key={column.id} column={column} filter={filter} />
                    ))}
                    {selectionStatus}
                    {toolbar === undefined && showColumnMenu ? (
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
                        <ul aria-label={caption} className="flex flex-col">
                            {Array.from({ length: skeletonRows }, (_, index) => (
                                <li key={index} className="border-b border-(--data-table-divider) py-3">
                                    <Skeleton shape="text" className="h-4 w-1/2" />
                                    <Skeleton shape="text" className="mt-2 h-3 w-3/4" />
                                </li>
                            ))}
                        </ul>
                    ) : rows.length === 0 ? (
                        emptyContent
                    ) : (
                        <ul aria-label={caption} className="flex flex-col">
                            {rowWindow.paddingBefore > 0 ? (
                                <li aria-hidden="true" style={{ height: rowWindow.paddingBefore }} />
                            ) : null}
                            {rowWindow.indices.map((index) => {
                                const item = items[index];
                                if (item === undefined) return null;
                                return item.kind === 'group' ? (
                                    <li
                                        key={`group:${item.id}`}
                                        data-index={index}
                                        ref={rowWindow.measure}
                                        className="flex items-baseline gap-2 border-b border-(--data-table-divider) pt-4 pb-1.5 text-xs font-medium text-(--data-table-header-text)"
                                    >
                                        <GroupLabel label={item.label} count={item.count} />
                                    </li>
                                ) : (
                                    <RowItem
                                        key={item.row.id}
                                        row={item.row}
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
                    // Scrolled content without a control in it is out of a keyboard's reach unless the box takes focus.
                    {...(rowWindow.virtual || overflowing
                        ? { role: 'region', 'aria-labelledby': captionId, tabIndex: 0 }
                        : {})}
                    className={cx(
                        // The box scrolls itself, so the header stays in view above the rows.
                        'max-h-(--data-table-max-height) overflow-auto focus-visible:-outline-offset-2',
                        fade !== null && FADE_CLASSES[fade],
                    )}
                >
                    <table
                        className={cx(
                            'w-full border-separate border-spacing-0 text-left text-sm text-(--data-table-text)',
                            'motion-safe:transition-opacity motion-safe:duration-(--motion-state) motion-safe:ease-standard',
                            fetching && '[filter:var(--data-table-fetching-filter)]',
                        )}
                    >
                        <caption
                            id={captionId}
                            className={showCaption ? 'pb-2 text-left text-base font-semibold' : 'sr-only'}
                        >
                            {caption}
                        </caption>
                        <thead className="sticky top-0 z-10 bg-(--data-table-header-bg)">
                            {table.getHeaderGroups().map((group) => (
                                <tr key={group.id}>
                                    {selection === undefined ? null : (
                                        <th scope="col" className={cx(HEADER_CELL, 'w-10 px-3')}>
                                            <Checkbox
                                                aria-label={messages.selectAllOnPage()}
                                                checked={table.getIsAllPageRowsSelected()}
                                                indeterminate={table.getIsSomePageRowsSelected()}
                                                disabled={rows.length === 0}
                                                onChange={table.getToggleAllPageRowsSelectedHandler()}
                                            />
                                        </th>
                                    )}
                                    {expansion === undefined ? null : <td className={cx(HEADER_CELL, 'w-10 px-1')} />}
                                    {group.headers.map((header) => (
                                        <HeaderCell
                                            key={header.id}
                                            header={header}
                                            table={table}
                                            sortable={showSorting}
                                        />
                                    ))}
                                    {rowActions === undefined ? null : <td className={cx(HEADER_CELL, 'w-10 px-1')} />}
                                </tr>
                            ))}
                        </thead>
                        {showSkeleton ? (
                            <tbody>
                                {Array.from({ length: skeletonRows }, (_, index) => (
                                    <tr key={index} style={{ height: rowHeight }}>
                                        {Array.from({ length: columnCount }, (_, cell) => (
                                            <td key={cell} className={BODY_CELL}>
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
                                        const item = items[index];
                                        if (item === undefined) return null;
                                        return (
                                            <tbody
                                                key={item.kind === 'group' ? `group:${item.id}` : item.row.id}
                                                data-index={index}
                                                ref={rowWindow.measure}
                                            >
                                                <TableItemRow item={item} context={rowContext} />
                                            </tbody>
                                        );
                                    })
                                ) : (
                                    <tbody>
                                        {items.map((item) => (
                                            <TableItemRow
                                                key={item.kind === 'group' ? `group:${item.id}` : item.row.id}
                                                item={item}
                                                context={rowContext}
                                            />
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

/** Header cells: quiet small labels over one hairline; cells carry the borders, which stay put under a sticky header. */
const HEADER_CELL = 'h-9 border-b border-(--data-table-divider) align-middle';
const BODY_CELL = 'h-(--data-table-row-height) border-b border-(--data-table-divider) px-3 py-1.5 align-middle';

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

function GroupLabel({ label, count }: { readonly label: string; readonly count: number }) {
    return (
        <>
            <span className="text-(--data-table-text)">{label}</span>
            <span className="text-(--data-table-muted) tabular-nums">{count}</span>
        </>
    );
}

function TableItemRow<TData extends RowData>({
    item,
    context,
}: {
    readonly item: TableItem<TData>;
    readonly context: RowContext<TData>;
}) {
    if (item.kind === 'row') return <TableRow row={item.row} context={context} />;
    return (
        <tr>
            <th
                scope="rowgroup"
                colSpan={context.columnCount}
                className="h-9 border-b border-(--data-table-divider) px-3 pt-3 text-left align-bottom text-xs font-medium"
            >
                <span className="inline-flex items-baseline gap-2">
                    <GroupLabel label={item.label} count={item.count} />
                </span>
            </th>
        </tr>
    );
}

function HeaderCell<TData extends RowData>({
    header,
    table,
    sortable,
}: {
    readonly header: Header<DataTableFeatures, TData>;
    readonly table: DataTableInstance<TData>;
    readonly sortable: boolean;
}) {
    const messages = useUiMessages();
    const { column } = header;
    const meta = column.columnDef.meta;
    const numeric = meta?.numeric === true;
    const content = header.isPlaceholder ? null : (
        <>
            {meta?.icon === undefined ? null : (
                <span aria-hidden="true" className="flex shrink-0 items-center text-(--data-table-header-icon)">
                    {meta.icon}
                </span>
            )}
            <table.FlexRender header={header} />
        </>
    );
    const cellClass = cx(
        HEADER_CELL,
        'text-2xs font-medium whitespace-nowrap text-(--data-table-header-text)',
        numeric && 'text-end',
    );
    if (!sortable || !column.getCanSort()) {
        return (
            <th scope="col" className={cx(cellClass, 'px-1.5')}>
                <span className="inline-flex items-center gap-1.5 px-1.5 py-1">{content}</span>
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
            className={cx(cellClass, 'px-1.5')}
        >
            <button
                type="button"
                aria-label={name}
                onClick={column.getToggleSortingHandler()}
                className={cx(
                    'group/sort inline-flex cursor-pointer items-center gap-1.5 rounded-small px-1.5 py-1 hover:bg-(--data-table-row-hover) hover:text-(--data-table-text)',
                    'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                    sorted !== false && 'text-(--data-table-text)',
                )}
            >
                {content}
                <Icon
                    aria-hidden="true"
                    className={cx(
                        'size-3.5 shrink-0',
                        // An unsorted column shows its arrows only on hover or focus, so the header row stays quiet.
                        sorted === false &&
                            'opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100',
                    )}
                />
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

/**
 * The row's ⋯ menu. With a mouse it appears on row hover; it stays in the tab order and shows on focus, and on touch
 * screens (no hover) it is always visible.
 */
function RowActionsMenu<TData extends RowData>({
    row,
    context,
    reveal,
}: {
    readonly row: TableRow<TData>;
    readonly context: RowContext<TData>;
    readonly reveal: boolean;
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
                    className={cx(
                        reveal &&
                            'pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100 pointer-fine:aria-expanded:opacity-100',
                    )}
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
                    'group/row hover:bg-(--data-table-row-hover)',
                    row.getIsSelected() && 'bg-(--data-table-row-selected)',
                )}
            >
                {selection === undefined ? null : (
                    <td className={BODY_CELL}>
                        <SelectRowCheckbox row={row} context={context} />
                    </td>
                )}
                {expansion === undefined ? null : (
                    <td className={cx(BODY_CELL, 'px-1')}>
                        <ExpandButton row={row} context={context} detailId={detailId} />
                    </td>
                )}
                {row.getVisibleCells().map((cell) => (
                    <td
                        key={cell.id}
                        className={cx(
                            BODY_CELL,
                            cell.column.columnDef.meta?.numeric === true && 'text-end tabular-nums',
                        )}
                    >
                        <table.FlexRender cell={cell} />
                    </td>
                ))}
                {rowActions === undefined ? null : (
                    <td className={cx(BODY_CELL, 'px-1 text-end')}>
                        <RowActionsMenu row={row} context={context} reveal />
                    </td>
                )}
            </tr>
            {isExpanded ? (
                <tr id={detailId} className="bg-(--data-table-expanded-bg)">
                    <td colSpan={context.columnCount} className="border-b border-(--data-table-divider) px-4 py-3">
                        {expansion.renderExpanded(row.original)}
                    </td>
                </tr>
            ) : null}
        </>
    );
}

interface NarrowLayout<TData extends RowData> {
    readonly title: Cell<DataTableFeatures, TData> | undefined;
    readonly trailing: readonly Cell<DataTableFeatures, TData>[];
    readonly meta: readonly Cell<DataTableFeatures, TData>[];
}

/** Splits a row's cells for the two-line item: a title, what trails it, and the meta line, by column priority. */
export function narrowLayout<TData extends RowData>(
    cells: readonly Cell<DataTableFeatures, TData>[],
): NarrowLayout<TData> {
    const ordered = cells
        .filter((cell) => cell.column.columnDef.meta?.hideOnCard !== true)
        .map((cell, order) => ({
            cell,
            order,
            priority: cell.column.columnDef.meta?.priority ?? Number.MAX_SAFE_INTEGER,
        }))
        .sort((a, b) => a.priority - b.priority || a.order - b.order)
        .map(({ cell }) => cell);
    const [title, ...rest] = ordered;
    return {
        title,
        trailing: rest.filter((cell) => cell.column.columnDef.meta?.trailing === true),
        meta: rest.filter((cell) => cell.column.columnDef.meta?.trailing !== true),
    };
}

/**
 * A row on a narrow screen: the title with what trails it on the first line, the other cells as a quiet meta line of
 * chips and values under it. Each value is labelled for screen readers, so nothing depends on its position.
 */
function RowItem<TData extends RowData>({
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
    const { title, trailing, meta } = narrowLayout(row.getVisibleCells());
    const isExpanded = expansion !== undefined && row.getIsExpanded();
    return (
        <li
            data-index={index}
            ref={measureRef}
            aria-labelledby={titleId}
            className={cx(
                'flex flex-col gap-1 border-b border-(--data-table-divider) py-2.5',
                row.getIsSelected() && 'bg-(--data-table-row-selected)',
            )}
        >
            <div className="flex min-h-6 items-center gap-2">
                {selection === undefined ? null : (
                    <span className="flex items-center">
                        <SelectRowCheckbox row={row} context={context} />
                    </span>
                )}
                <div id={titleId} className="min-w-0 flex-1 font-medium break-words">
                    {title === undefined ? context.getRowLabel(row.original) : <table.FlexRender cell={title} />}
                </div>
                {trailing.map((cell) => (
                    <span key={cell.id} className="shrink-0 text-xs text-(--data-table-muted) tabular-nums">
                        <span className="sr-only">{`${columnLabel(cell.column)}: `}</span>
                        <table.FlexRender cell={cell} />
                    </span>
                ))}
                {expansion === undefined ? null : <ExpandButton row={row} context={context} detailId={detailId} />}
                <RowActionsMenu row={row} context={context} reveal={false} />
            </div>
            {meta.length === 0 ? null : (
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--data-table-muted)">
                    {meta.map((cell) => (
                        <span
                            key={cell.id}
                            className={cx(
                                'inline-flex min-w-0 items-center',
                                cell.column.columnDef.meta?.numeric === true && 'tabular-nums',
                            )}
                        >
                            <span className="sr-only">{`${columnLabel(cell.column)}: `}</span>
                            <table.FlexRender cell={cell} />
                        </span>
                    ))}
                </div>
            )}
            {isExpanded ? (
                <div id={detailId} className="pt-2">
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
                <Button {...triggerProps} size="sm" variant="ghost">
                    <Columns3 aria-hidden="true" className="size-4" />
                    {messages.columns()}
                </Button>
            )}
        />
    );
}
