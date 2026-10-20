import { useVirtualizer } from '@tanstack/react-virtual';
import type { RefObject } from 'react';

export interface RowWindow {
    readonly virtual: boolean;
    /** Indices of the rows to render, in order. */
    readonly indices: readonly number[];
    /** Space before and after the rendered rows, in px, standing in for the rows that are not mounted. */
    readonly paddingBefore: number;
    readonly paddingAfter: number;
    /** Ref for each rendered row's element (it carries `data-index`), so rows taller than estimated are measured. */
    readonly measure: (element: Element | null) => void;
}

export interface RowWindowOptions {
    readonly count: number;
    readonly enabled: boolean;
    readonly rowHeight: number;
    readonly scrollRef: RefObject<HTMLElement | null>;
    readonly getKey: (index: number) => string;
}

const noMeasure = (): void => undefined;

/**
 * The rows to mount: all of them, or above the threshold only the visible window plus overscan (TanStack Virtual).
 * Rows stay in normal flow between two spacers, so table markup stays valid and nothing is positioned absolutely.
 */
export function useRowWindow({ count, enabled, rowHeight, scrollRef, getKey }: RowWindowOptions): RowWindow {
    // The React Compiler cannot memoise TanStack Virtual's mutable instance; neither app compiles with it.
    // eslint-disable-next-line react-hooks/incompatible-library
    const virtualizer = useVirtualizer<HTMLElement, Element>({
        count: enabled ? count : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => rowHeight,
        getItemKey: getKey,
        overscan: 8,
        // Without layout (jsdom, a hidden tab) an element measures 0; the estimate is the better answer then.
        measureElement: (element) => element.getBoundingClientRect().height || rowHeight,
    });
    if (!enabled) {
        return {
            virtual: false,
            indices: Array.from({ length: count }, (_, index) => index),
            paddingBefore: 0,
            paddingAfter: 0,
            measure: noMeasure,
        };
    }
    const items = virtualizer.getVirtualItems();
    const first = items[0];
    const last = items.at(-1);
    return {
        virtual: true,
        indices: items.map((item) => item.index),
        paddingBefore: first?.start ?? 0,
        paddingAfter: last === undefined ? 0 : virtualizer.getTotalSize() - last.end,
        measure: virtualizer.measureElement,
    };
}
