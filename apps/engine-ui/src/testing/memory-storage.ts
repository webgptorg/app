import type { PreferenceStorage } from '@ptbk/ui';

/** An in-memory `localStorage` stand-in; share one between two renders to simulate a reload. */
export interface MemoryStorage extends PreferenceStorage {
    readonly entries: ReadonlyMap<string, string>;
}

export function createMemoryStorage(initial: Readonly<Record<string, string>> = {}): MemoryStorage {
    const entries = new Map(Object.entries(initial));
    return {
        entries,
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value) => {
            entries.set(key, value);
        },
    };
}

/** A storage that refuses every access, like a browser with site data blocked. */
export const REFUSING_STORAGE: PreferenceStorage = {
    getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
    },
    setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
    },
};
