import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, PointerEvent } from 'react';

/** Long enough that sweeping the pointer across the icons doesn't flash every label. */
const HOVER_DELAY_MS = 300;
const GAP_PX = 8;

interface Shown {
    readonly text: string;
    readonly style: CSSProperties;
}

export interface CollapsedNavLabelTarget {
    readonly onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
    readonly onPointerLeave: () => void;
    readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
    readonly onBlur: () => void;
}

function placeBeside(anchor: HTMLElement): CSSProperties {
    const rect = anchor.getBoundingClientRect();
    const rtl = getComputedStyle(anchor).direction === 'rtl';
    const top = `${String(rect.top + rect.height / 2)}px`;
    return rtl
        ? { top, right: `${String(document.documentElement.clientWidth - rect.left + GAP_PX)}px` }
        : { top, left: `${String(rect.right + GAP_PX)}px` };
}

/**
 * The visible name of an icon-only sidebar link, beside it on hover and on keyboard focus (a native `title` shows only
 * on hover, late). A top-layer popover, so the nav's scroll container can't clip it; the link keeps its own accessible
 * name, so this is hidden from assistive technology. A shared `Tooltip` in `@ptbk/ui` would replace it.
 */
export function useCollapsedNavLabel(enabled: boolean) {
    const popover = useRef<HTMLDivElement>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [state, setShown] = useState<Shown | null>(null);
    const shown = enabled ? state : null;

    const show = (anchor: HTMLElement, text: string) => {
        clearTimeout(timer.current);
        setShown({ text, style: placeBeside(anchor) });
    };
    const hide = () => {
        clearTimeout(timer.current);
        setShown(null);
    };

    useEffect(() => {
        const element = popover.current;
        if (element === null) return;
        element.togglePopover(shown !== null);
        if (shown === null) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') hide();
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
        };
    }, [shown]);

    useEffect(
        () => () => {
            clearTimeout(timer.current);
        },
        [],
    );

    const target = (text: string): CollapsedNavLabelTarget | undefined =>
        enabled
            ? {
                  onPointerEnter: (event) => {
                      const anchor = event.currentTarget;
                      clearTimeout(timer.current);
                      timer.current = setTimeout(() => {
                          show(anchor, text);
                      }, HOVER_DELAY_MS);
                  },
                  onPointerLeave: hide,
                  onFocus: (event) => {
                      show(event.currentTarget, text);
                  },
                  onBlur: hide,
              }
            : undefined;

    const element = enabled ? (
        <div
            ref={popover}
            popover="manual"
            aria-hidden="true"
            style={shown?.style}
            className="pointer-events-none fixed inset-auto m-0 -translate-y-1/2 rounded-control border border-divider bg-raised px-2 py-1 text-sm font-medium text-text shadow-raised"
        >
            {shown?.text}
        </div>
    ) : null;

    return { target, element };
}
