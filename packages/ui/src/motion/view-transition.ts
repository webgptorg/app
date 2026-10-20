import { prefersReducedMotion } from './reduced-motion';
import type { MotionMatchMedia } from './reduced-motion';

export interface ViewTransitionDocument {
    startViewTransition?: (update: () => void) => unknown;
}

/** Whether layout changes may animate through the View Transitions API: supported and motion not reduced. */
export function canUseViewTransitions(
    doc: ViewTransitionDocument | undefined = typeof document === 'undefined' ? undefined : document,
    matchMedia?: MotionMatchMedia,
): boolean {
    return typeof doc?.startViewTransition === 'function' && !prefersReducedMotion(matchMedia);
}

/** Runs `update` inside a view transition when allowed, otherwise directly; either way `update` runs exactly once. */
export function withViewTransition(
    update: () => void,
    doc: ViewTransitionDocument | undefined = typeof document === 'undefined' ? undefined : document,
    matchMedia?: MotionMatchMedia,
): void {
    if (doc !== undefined && canUseViewTransitions(doc, matchMedia)) {
        doc.startViewTransition?.(update);
        return;
    }
    update();
}
