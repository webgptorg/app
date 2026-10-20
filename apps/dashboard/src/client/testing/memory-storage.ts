import type { PreferenceStorage } from '@ptbk/ui';

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
