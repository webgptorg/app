import {
    columnFilteringFeature,
    columnVisibilityFeature,
    createColumnHelper,
    createFilteredRowModel,
    createSortedRowModel,
    filterFn_equalsString,
    filterFn_includesString,
    rowExpandingFeature,
    rowSelectionFeature,
    rowSortingFeature,
    sortFn_alphanumeric,
    sortFn_basic,
    sortFn_datetime,
    sortFn_text,
    tableFeatures,
} from '@tanstack/react-table';
import type { CellContext, ColumnDef, ColumnHelper, HeaderContext, Row, RowData } from '@tanstack/react-table';

/** State shapes apps bind to search params; re-exported so apps never depend on TanStack Table directly. */
export type {
    ColumnFiltersState,
    ColumnFilter,
    ColumnSort,
    ColumnVisibilityState,
    RowData,
    RowSelectionState,
    SortingState,
} from '@tanstack/react-table';

/** A choice in a column's select filter. */
export interface DataTableFilterOption {
    readonly value: string;
    readonly label: string;
}

/** A filter control `DataTable` renders above the rows for this column, bound to `columnFilters`. */
export type DataTableColumnFilter =
    | { readonly kind: 'text'; readonly placeholder?: string }
    | {
          readonly kind: 'select';
          readonly options: readonly DataTableFilterOption[];
          /** The "no filter" choice, e.g. "All statuses". */
          readonly allLabel: string;
      };

/** What `DataTable` reads from a column besides TanStack Table's own definition. */
export interface DataTableColumnMeta {
    /**
     * The column's name where the header is not plain text, and its label on a card and in the column menu. Defaults
     * to the header when that is a string.
     */
    readonly label?: string;
    /** Order on a narrow-screen card, lowest first; the first column is the card's title. Unset columns come last. */
    readonly priority?: number;
    /** Leave the column off narrow-screen cards (e.g. a long description already in the title). */
    readonly hideOnCard?: boolean;
    readonly filter?: DataTableColumnFilter;
}

/**
 * The TanStack Table features every `DataTable` registers. Server-side mode sets the `manual*` flags, so the sorted
 * and filtered row models only run in client-side mode.
 */
// A type-only slot: TanStack Table reads the type of `columnMeta`, never its value.
const COLUMN_META: DataTableColumnMeta = {};

export const dataTableFeatures = tableFeatures({
    columnFilteringFeature,
    filteredRowModel: createFilteredRowModel(),
    filterFns: { includesString: filterFn_includesString, equalsString: filterFn_equalsString },
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
    sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime, basic: sortFn_basic },
    columnVisibilityFeature,
    rowSelectionFeature,
    rowExpandingFeature,
    columnMeta: COLUMN_META,
});

export type DataTableFeatures = typeof dataTableFeatures;

// TanStack Table's column types are generic over each column's value; a list of columns mixes value types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataTableColumnDef<TData extends RowData> = ColumnDef<DataTableFeatures, TData, any>;

export type DataTableColumnHelper<TData extends RowData> = ColumnHelper<DataTableFeatures, TData>;

/** Typed column definitions for `DataTable`, so apps never import TanStack Table themselves. */
export function createDataTableColumnHelper<TData extends RowData>(): DataTableColumnHelper<TData> {
    return createColumnHelper<DataTableFeatures, TData>();
}

export type DataTableRow<TData extends RowData> = Row<DataTableFeatures, TData>;
export type DataTableCellContext<TData extends RowData, TValue = unknown> = CellContext<
    DataTableFeatures,
    TData,
    TValue
>;
export type DataTableHeaderContext<TData extends RowData, TValue = unknown> = HeaderContext<
    DataTableFeatures,
    TData,
    TValue
>;
