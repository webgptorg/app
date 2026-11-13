import type { CSSProperties } from 'react';

/**
 * A `view-transition-name` for one entity's title, the same on its list row and its detail heading, so the router's
 * View Transition morphs one into the other. IDs are engine data: anything outside `[A-Za-z0-9-]` is written as `_hex`,
 * so the name is always a valid, unique `<custom-ident>` and never CSS syntax. Set through the CSSOM (`style`), which
 * the engine's CSP allows; under reduced motion the router starts no transitions, so the name does nothing.
 */
export function morphName(kind: string, id: string): string {
    const safe = Array.from(id, (char) =>
        /^[A-Za-z0-9-]$/.test(char) ? char : `_${(char.codePointAt(0) ?? 0).toString(16)}`,
    ).join('');
    return `${kind}-title-${safe}`;
}

export function morphStyle(kind: string, id: string): CSSProperties {
    return { viewTransitionName: morphName(kind, id) };
}
