import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

/** Distance between the anchor and the popover, and between the popover and the viewport edge, in CSS pixels. */
const GAP = 4;
const VIEWPORT_MARGIN = 8;

export interface PopoverPosition {
    readonly top: number;
    readonly left: number;
}

export interface Box {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly width: number;
    readonly height: number;
}

export interface Viewport {
    readonly width: number;
    readonly height: number;
}

/** Below the anchor and lined up with its start edge, flipped above or pulled inwards where the viewport ends. */
export function placePopover(anchor: Box, popover: Box, viewport: Viewport, rtl: boolean): PopoverPosition {
    const preferredLeft = rtl ? anchor.right - popover.width : anchor.left;
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - popover.width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft);
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - popover.height;
    const fitsBelow = below + popover.height <= viewport.height - VIEWPORT_MARGIN;
    return { top: fitsBelow || above < VIEWPORT_MARGIN ? below : above, left };
}

export interface AnchoredPopover {
    readonly ref: RefObject<HTMLDivElement | null>;
    readonly open: boolean;
    readonly style: CSSProperties | undefined;
    readonly show: (anchor: HTMLElement) => void;
    /** Hides it; `returnFocus` puts focus back on the element it was opened from. */
    readonly hide: (returnFocus: boolean) => void;
}

/**
 * A Popover API element (top layer, no portal, no injected styles) placed at the element that opened it. The position
 * is set through the CSSOM, which the CSP allows.
 */
export function useAnchoredPopover(): AnchoredPopover {
    const ref = useRef<HTMLDivElement>(null);
    const anchorRef = useRef<HTMLElement | null>(null);
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState<PopoverPosition | null>(null);

    const show = useCallback((anchor: HTMLElement) => {
        anchorRef.current = anchor;
        // `togglePopover(true)` rather than `showPopover()`, which throws on a popover that is already open.
        ref.current?.togglePopover(true);
        setOpen(true);
    }, []);

    const hide = useCallback((returnFocus: boolean) => {
        ref.current?.togglePopover(false);
        setOpen(false);
        if (returnFocus) anchorRef.current?.focus();
    }, []);

    useEffect(() => {
        const element = ref.current;
        if (element === null) return;
        // Light dismiss (a click outside) closes the popover without us; keep state in step.
        const onToggle = (event: Event) => {
            if ((event as Event & { newState?: string }).newState === 'closed') setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            hide(true);
        };
        // Tabbing out of a non-modal popover closes it, as a menu does; focus has already moved on.
        const onFocusOut = (event: FocusEvent) => {
            const next = event.relatedTarget;
            if (next instanceof Node && !element.contains(next)) hide(false);
        };
        element.addEventListener('toggle', onToggle);
        element.addEventListener('keydown', onKeyDown);
        element.addEventListener('focusout', onFocusOut);
        return () => {
            element.removeEventListener('toggle', onToggle);
            element.removeEventListener('keydown', onKeyDown);
            element.removeEventListener('focusout', onFocusOut);
        };
    }, [hide]);

    useLayoutEffect(() => {
        const element = ref.current;
        if (!open || element === null) return;
        const reposition = () => {
            const anchor = anchorRef.current;
            if (anchor === null) return;
            setPosition(
                placePopover(
                    anchor.getBoundingClientRect(),
                    element.getBoundingClientRect(),
                    { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight },
                    getComputedStyle(anchor).direction === 'rtl',
                ),
            );
        };
        reposition();
        // The content changes size between steps (fields, values, dates), so measure again whenever it does.
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : undefined;
        observer?.observe(element);
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
        };
    }, [open]);

    const style: CSSProperties | undefined =
        position === null ? undefined : { top: `${String(position.top)}px`, left: `${String(position.left)}px` };
    return { ref, open, style, show, hide };
}
