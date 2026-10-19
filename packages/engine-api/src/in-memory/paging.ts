import type { Page } from '../common';

export type SortValue = string | number | null;

export interface SortSpec<T> {
    /** Part of the cursor, so a cursor from another sort order is refused. */
    readonly name: string;
    readonly key: (item: T) => SortValue;
    readonly descending: boolean;
    readonly id: (item: T) => string;
}

export type PageOutcome<T> = { readonly kind: 'page'; readonly page: Page<T> } | { readonly kind: 'invalid-cursor' };

/**
 * Keyset paging: the cursor holds the last item's sort key and ID, so the next page starts strictly after it and
 * inserts elsewhere in the list never shift or repeat items.
 */
export function paginate<T>(
    items: readonly T[],
    spec: SortSpec<T>,
    query: { readonly cursor?: string | undefined; readonly limit: number },
): PageOutcome<T> {
    const compare = (a: readonly [SortValue, string], b: readonly [SortValue, string]): number => {
        const byKey = compareValues(a[0], b[0], spec.descending);
        if (byKey !== 0) return byKey;
        return spec.descending ? b[1].localeCompare(a[1]) : a[1].localeCompare(b[1]);
    };
    const sorted = [...items].sort((a, b) => compare([spec.key(a), spec.id(a)], [spec.key(b), spec.id(b)]));
    let start = 0;
    if (query.cursor !== undefined) {
        const position = decodeCursor(query.cursor, spec.name);
        if (!position) return { kind: 'invalid-cursor' };
        start = sorted.findIndex((item) => compare([spec.key(item), spec.id(item)], position) > 0);
        if (start === -1) start = sorted.length;
    }
    const pageItems = sorted.slice(start, start + query.limit);
    const last = pageItems.at(-1);
    const hasMore = start + query.limit < sorted.length;
    return {
        kind: 'page',
        page: {
            items: pageItems,
            nextCursor: hasMore && last !== undefined ? encodeCursor(spec.name, spec.key(last), spec.id(last)) : null,
        },
    };
}

/** Nulls sort last in both directions, so "never used" stays at the end of a `lastUsedAt` list. */
function compareValues(a: SortValue, b: SortValue, descending: boolean): number {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    const order = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
    return descending ? -order : order;
}

function encodeCursor(sort: string, key: SortValue, id: string): string {
    const bytes = new TextEncoder().encode(JSON.stringify([sort, key, id]));
    return btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
}

function decodeCursor(cursor: string, sort: string): readonly [SortValue, string] | undefined {
    try {
        const binary = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
        const decoded: unknown = JSON.parse(
            new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
        );
        if (!Array.isArray(decoded) || decoded.length !== 3) return undefined;
        const [cursorSort, key, id] = decoded as unknown[];
        if (cursorSort !== sort || typeof id !== 'string') return undefined;
        if (key !== null && typeof key !== 'string' && typeof key !== 'number') return undefined;
        return [key, id];
    } catch {
        return undefined;
    }
}
