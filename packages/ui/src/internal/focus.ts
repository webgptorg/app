const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Elements inside `container` that Tab can reach, in document order. */
export function focusableIn(container: Element): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.closest('[hidden], [inert]') === null,
    );
}

/**
 * Keeps Tab and Shift+Tab inside `container`, wrapping at either end. Returns whether it moved focus, so the caller
 * can prevent the default. Browsers already make the page behind a modal `<dialog>` inert, but Tab would still leave
 * for the browser's own UI; wrapping keeps keyboard users in the dialog until they close it.
 */
export function wrapTabFocus(container: Element, backwards: boolean): boolean {
    const focusable = focusableIn(container);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return true;
    const active = document.activeElement;
    const inside = active !== null && container.contains(active) && active !== container;
    if (backwards && (!inside || active === first)) {
        last.focus();
        return true;
    }
    if (!backwards && (!inside || active === last)) {
        first.focus();
        return true;
    }
    return false;
}
