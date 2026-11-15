import type { FilterBarDateRange } from '@ptbk/ui';

/**
 * How a `FilterBar` field maps onto a list's search params, so a filtered view is a URL that reloads and shares.
 * Search schemas keep parsing strictly (unknown values fall back to "no filter"); these only translate shapes.
 */

/** The values of a set param like `status=queued,failed`, in `known`'s order; unknown parts are dropped. */
export function readListParam<T extends string>(value: string | undefined, known: readonly T[]): T[] {
    const parts = new Set(value?.split(',') ?? []);
    return known.filter((candidate) => parts.has(candidate));
}

/** A set param in canonical order, so the same view always has the same URL; `undefined` for none. */
export function writeListParam<T extends string>(values: readonly T[], known: readonly T[]): string | undefined {
    const joined = known.filter((candidate) => values.includes(candidate)).join(',');
    return joined === '' ? undefined : joined;
}

/** A single-value param as the one-element list an entity field holds. */
export function readOneParam<T extends string>(value: T | undefined): T[] {
    return value === undefined ? [] : [value];
}

/** `from` and `to` day params as a date-range field's value. */
export function readRangeParams(search: {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
}): FilterBarDateRange {
    return { from: search.from, to: search.to };
}
