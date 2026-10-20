import type { ColumnVisibilityState } from '@tanstack/react-table';

/** A `localStorage`-shaped store; reading or writing may throw (private mode, blocked storage). */
export interface DataTableStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** Hidden columns as stored per device; anything unreadable or malformed means "all visible". */
export function readColumnVisibility(storage: DataTableStorage | undefined, key: string): ColumnVisibilityState {
    try {
        const raw = storage?.getItem(key);
        if (raw === null || raw === undefined) return {};
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        return Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
        );
    } catch {
        return {};
    }
}

export function persistColumnVisibility(
    storage: DataTableStorage | undefined,
    key: string,
    visibility: ColumnVisibilityState,
): void {
    try {
        storage?.setItem(key, JSON.stringify(visibility));
    } catch {
        // Still applies on this page; it just will not survive a reload.
    }
}
