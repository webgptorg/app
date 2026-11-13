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
import type { ReactNode } from 'react';

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
    /** A small monochrome icon before the header's name (lucide, `size-3.5`). Decorative. */
    readonly icon?: ReactNode;
    /** Times, durations, sizes, counts, money: tabular figures, lined up at the end. */
    readonly numeric?: boolean;
    /**
     * Order on a narrow screen, where each row is two lines, lowest first: the first column is the row's title line,
     * the rest its meta line. Unset columns come last.
     */
    readonly priority?: number;
    /** On a narrow screen, at the end of the title line (e.g. a time or a status) rather than on the meta line. */
    readonly trailing?: boolean;
    /** Leave the column out on a narrow screen (e.g. a long description already in the title). */
    readonly hideOnCard?: boolean;
    /**
     * Start hidden, on cards too, until the reader turns the column on in the column menu (which a hidden column
     * keeps shown). Ignored when the app controls `columnVisibility` or the column cannot hide.
     */
    readonly defaultHidden?: boolean;
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
