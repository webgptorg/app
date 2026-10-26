import { useCallback, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

/** Which physical sides of a horizontal scroller hide content, so the list can fade there and hint at more. */
export interface ScrollEdges {
    readonly left: boolean;
    readonly right: boolean;
}

export interface ScrollBox {
    readonly scrollLeft: number;
    readonly scrollWidth: number;
    readonly clientWidth: number;
    readonly rtl: boolean;
}

const NO_EDGES: ScrollEdges = { left: false, right: false };
// Sub-pixel layout leaves a fraction of a pixel "hidden" at a fully scrolled end.
const SLACK_PX = 1;

export function scrollEdges({ scrollLeft, scrollWidth, clientWidth, rtl }: ScrollBox): ScrollEdges {
    const max = scrollWidth - clientWidth;
    if (max <= SLACK_PX) return NO_EDGES;
    // In right-to-left layout `scrollLeft` is 0 at the right end and negative towards the left.
    const fromLeft = rtl ? max + scrollLeft : scrollLeft;
    return { left: fromLeft > SLACK_PX, right: fromLeft < max - SLACK_PX };
}

export interface Span {
    readonly start: number;
    readonly width: number;
}

/** The `scrollLeft` that brings `item` fully into `view` (both in the scroller's content coordinates), or `null`. */
export function revealScrollLeft(view: Span, item: Span): number | null {
    if (item.start < view.start) return item.start;
    const itemEnd = item.start + item.width;
    if (itemEnd > view.start + view.width) return itemEnd - view.width;
    return null;
}

/**
 * Tracks the hidden edges of a horizontal scroller and keeps the element `selector` matches in view whenever `key`
 * changes, e.g. the selected tab on a phone, where the list is wider than the screen.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, selector: string, key: string): ScrollEdges {
    const [edges, setEdges] = useState(NO_EDGES);
    const measure = useCallback(() => {
        const element = ref.current;
        if (element === null) return;
        const next = scrollEdges({
            scrollLeft: element.scrollLeft,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            rtl: getComputedStyle(element).direction === 'rtl',
        });
        setEdges((current) => (current.left === next.left && current.right === next.right ? current : next));
    }, [ref]);

    useLayoutEffect(() => {
        const element = ref.current;
        if (element === null) return;
        const item = element.querySelector<HTMLElement>(selector);
        if (item !== null) {
            const view = element.getBoundingClientRect();
            const box = item.getBoundingClientRect();
            const target = revealScrollLeft(
                { start: element.scrollLeft, width: view.width },
                { start: element.scrollLeft + box.left - view.left, width: box.width },
            );
            if (target !== null) element.scrollLeft = target;
        }
        measure();
    }, [ref, selector, key, measure]);

    useLayoutEffect(() => {
        const element = ref.current;
        if (element === null) return;
        element.addEventListener('scroll', measure, { passive: true });
        const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
        observer?.observe(element);
        return () => {
            element.removeEventListener('scroll', measure);
            observer?.disconnect();
        };
    }, [ref, measure]);

    return edges;
}
