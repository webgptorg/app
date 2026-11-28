import type { PreferenceStorage } from '@ptbk/ui';

import type { OwnerSetupStorage } from '../features/engines/owner-handoff';

export function createMemoryStorage(initial: Readonly<Record<string, string>> = {}): PreferenceStorage & {
    readonly entries: ReadonlyMap<string, string>;
} {
    const entries = new Map(Object.entries(initial));
    return {
        entries,
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value) => {
            entries.set(key, value);
        },
    };
}

/** A tab's `sessionStorage` in memory, for the owner setup secret. */
export function createMemorySessionStorage(initial: Readonly<Record<string, string>> = {}): OwnerSetupStorage & {
    readonly entries: ReadonlyMap<string, string>;
} {
    const entries = new Map(Object.entries(initial));
    return {
        entries,
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value) => {
            entries.set(key, value);
        },
        removeItem: (key) => {
            entries.delete(key);
        },
    };
}
