import type { ThemeMatchMedia } from '../app/theme';

export interface FakeMatchMedia {
    readonly matchMedia: ThemeMatchMedia;
    /** Changes what a query matches and notifies its listeners, like the OS switching to dark mode. */
    set(query: string, matches: boolean): void;
}

export function createFakeMatchMedia(initial: Readonly<Record<string, boolean>> = {}): FakeMatchMedia {
    const state = new Map(Object.entries(initial));
    const listeners = new Map<string, Set<() => void>>();
    const listenersOf = (query: string) => {
        const set = listeners.get(query) ?? new Set<() => void>();
        listeners.set(query, set);
        return set;
    };
    return {
        matchMedia: (query) =>
            ({
                get matches() {
                    return state.get(query) ?? false;
                },
                addEventListener: (_type: string, listener: () => void) => {
                    listenersOf(query).add(listener);
                },
                removeEventListener: (_type: string, listener: () => void) => {
                    listenersOf(query).delete(listener);
                },
            }) as ReturnType<ThemeMatchMedia>,
        set: (query, matches) => {
            state.set(query, matches);
            for (const listener of listenersOf(query)) listener();
        },
    };
}
