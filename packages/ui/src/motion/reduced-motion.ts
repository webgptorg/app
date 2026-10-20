import { useSyncExternalStore } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export type MotionMatchMedia = (
    query: string,
) => Pick<MediaQueryList, 'matches'> & Partial<Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>>;

function browserMatchMedia(): MotionMatchMedia | undefined {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    return (query) => window.matchMedia(query);
}

export function prefersReducedMotion(matchMedia: MotionMatchMedia | undefined = browserMatchMedia()): boolean {
    return matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

/** Whether the user asked for reduced motion, live; JS-driven motion uses it the way CSS uses the media query. */
export function useReducedMotion(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => prefersReducedMotion(),
        () => false,
    );
}

function subscribe(onChange: () => void): () => void {
    const query = browserMatchMedia()?.(REDUCED_MOTION_QUERY);
    query?.addEventListener?.('change', onChange);
    return () => query?.removeEventListener?.('change', onChange);
}
