import type { CSSProperties } from 'react';

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

const PLAIN = /[A-Za-z0-9-]/;

/**
 * A `view-transition-name` for one entity's element, unique per `scope` and `id`: give the same name to a list row's
 * title and the detail page's title and the route change morphs one into the other. Names are CSS identifiers, so
 * every other character of the (engine-provided) id is escaped as `_<hex>`, which keeps distinct ids distinct.
 */
export function viewTransitionName(scope: string, id: string): string {
    const escape = (text: string) =>
        Array.from(text, (char) => (PLAIN.test(char) ? char : `_${(char.codePointAt(0) ?? 0).toString(16)}_`)).join('');
    return `ptbk-${escape(scope)}--${escape(id)}`;
}

/**
 * The name as a style object, which React applies through the CSSOM, so the engine's CSP holds. A name must be unique
 * on the page: where a list can show the same entity twice, name only one of them.
 */
export function viewTransitionStyle(scope: string, id: string): CSSProperties {
    return { viewTransitionName: viewTransitionName(scope, id) };
}
