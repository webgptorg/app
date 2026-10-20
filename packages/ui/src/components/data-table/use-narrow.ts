import { useSyncExternalStore } from 'react';

/** Below Tailwind's `md` breakpoint (768 px) tables become cards. */
export const NARROW_QUERY = '(max-width: 767.98px)';

function query(): MediaQueryList | undefined {
    return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
        ? undefined
        : window.matchMedia(NARROW_QUERY);
}

function subscribe(onChange: () => void): () => void {
    const list = query();
    list?.addEventListener('change', onChange);
    return () => list?.removeEventListener('change', onChange);
}

/**
 * Whether the viewport is narrow. Decided in JS rather than CSS so only one of the two layouts (table or cards) is in
 * the document and the accessibility tree at a time.
 */
export function useNarrow(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => query()?.matches ?? false,
        () => false,
    );
}
