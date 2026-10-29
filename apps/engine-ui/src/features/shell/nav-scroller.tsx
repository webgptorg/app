import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Overflow = 'none' | 'start' | 'end' | 'both';

function overflowOf(element: HTMLElement): Overflow {
    const before = element.scrollTop > 0;
    // Rounding at fractional zoom can leave a pixel or two of "overflow" at the very end.
    const after = element.scrollTop + element.clientHeight < element.scrollHeight - 2;
    if (before && after) return 'both';
    if (before) return 'start';
    if (after) return 'end';
    return 'none';
}

/**
 * The sidebar's scrolling nav area. On a short screen it fades out at the edge that has more items behind it, since a
 * scroll container without a visible scrollbar gives no other hint that Settings is further down.
 */
export function NavScroller({ children }: { readonly children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    const [overflow, setOverflow] = useState<Overflow>('none');
    useEffect(() => {
        const element = ref.current;
        if (element === null) return;
        const update = () => {
            setOverflow(overflowOf(element));
        };
        update();
        element.addEventListener('scroll', update, { passive: true });
        const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
        resize?.observe(element);
        if (element.firstElementChild !== null) resize?.observe(element.firstElementChild);
        return () => {
            element.removeEventListener('scroll', update);
            resize?.disconnect();
        };
    }, []);
    return (
        <div ref={ref} data-nav-scroller={overflow} className="min-h-0 flex-1 overflow-y-auto">
            {children}
        </div>
    );
}
