import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, PointerEvent, ReactNode } from 'react';

/** Handlers and the description link to spread onto the element the tooltip explains. */
export interface TooltipTriggerProps {
    readonly 'aria-describedby': string;
    readonly onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
    readonly onPointerLeave: () => void;
    readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
    readonly onBlur: () => void;
}

export interface TooltipState {
    readonly triggerProps: TooltipTriggerProps;
    /** Shows it at `anchor`, e.g. when a touch user taps a soft-disabled button. */
    readonly show: (anchor: HTMLElement) => void;
    /** Render next to the trigger, in the same dialog if it has one, so the top layer keeps it clickable. */
    readonly tooltip: ReactNode;
}

const GAP = 6;
const VIEWPORT_MARGIN = 8;
/** Long enough to move the pointer from the trigger onto the tooltip (WCAG 1.4.13, hoverable). */
const HIDE_DELAY_MS = 150;

function place(anchor: DOMRect, tip: DOMRect): CSSProperties {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const above = anchor.top - GAP - tip.height >= VIEWPORT_MARGIN;
    const top = above ? anchor.top - GAP - tip.height : anchor.bottom + GAP;
    const centred = anchor.left + anchor.width / 2 - tip.width / 2;
    const left = Math.min(
        Math.max(centred, VIEWPORT_MARGIN),
        Math.max(VIEWPORT_MARGIN, viewportWidth - tip.width - VIEWPORT_MARGIN),
    );
    return { top, left };
}

/**
 * A short text explaining a control, shown on hover and keyboard focus, hoverable itself and dismissed with Esc
 * (WCAG 1.4.13). It is a manual popover in the top layer, placed through the CSSOM (no inline style attribute, so the
 * engine's CSP holds), and always linked by `aria-describedby`, so screen readers get it without it being shown.
 */
export function useTooltip(text: string): TooltipState {
    const id = useId();
    const tipRef = useRef<HTMLSpanElement>(null);
    const anchorRef = useRef<HTMLElement | null>(null);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState<CSSProperties | undefined>(undefined);

    const cancelHide = () => {
        clearTimeout(hideTimer.current);
    };
    const show = useCallback((anchor: HTMLElement) => {
        clearTimeout(hideTimer.current);
        anchorRef.current = anchor;
        setOpen(true);
    }, []);
    const hide = () => {
        clearTimeout(hideTimer.current);
        setOpen(false);
    };
    const scheduleHide = () => {
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => {
            setOpen(false);
        }, HIDE_DELAY_MS);
    };

    useLayoutEffect(() => {
        const tip = tipRef.current;
        const anchor = anchorRef.current;
        if (tip === null) return;
        if (!open || anchor === null) {
            tip.togglePopover(false);
            return;
        }
        tip.togglePopover(true);
        setPosition(place(anchor.getBoundingClientRect(), tip.getBoundingClientRect()));
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            // Esc closes the tooltip first; the dialog around it stays open until the next press.
            event.stopPropagation();
            event.preventDefault();
            setOpen(false);
        };
        const onScroll = () => {
            setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('scroll', onScroll, true);
        };
    }, [open]);

    useEffect(
        () => () => {
            clearTimeout(hideTimer.current);
        },
        [],
    );

    return {
        triggerProps: {
            'aria-describedby': id,
            onPointerEnter: (event) => {
                show(event.currentTarget);
            },
            onPointerLeave: scheduleHide,
            onFocus: (event) => {
                show(event.currentTarget);
            },
            onBlur: hide,
        },
        show,
        tooltip: (
            <span
                ref={tipRef}
                id={id}
                role="tooltip"
                popover="manual"
                style={position}
                onPointerEnter={cancelHide}
                onPointerLeave={scheduleHide}
                className="fixed inset-auto m-0 max-w-64 rounded-(--tooltip-radius) border-0 bg-(--tooltip-bg) px-2 py-1 text-xs text-(--tooltip-text) shadow-(--tooltip-shadow)"
            >
                {text}
            </span>
        ),
    };
}

export interface TooltipProps {
    readonly content: string;
    readonly children: (triggerProps: TooltipTriggerProps) => ReactNode;
}

/** `useTooltip` for any trigger, e.g. an icon-only button in a collapsed sidebar. */
export function Tooltip({ content, children }: TooltipProps) {
    const { triggerProps, tooltip } = useTooltip(content);
    return (
        <>
            {children(triggerProps)}
            {tooltip}
        </>
    );
}

interface TooltipHandlers<T extends HTMLElement> {
    readonly onPointerEnter?: ((event: PointerEvent<T>) => void) | undefined;
    readonly onPointerLeave?: ((event: PointerEvent<T>) => void) | undefined;
    readonly onFocus?: ((event: FocusEvent<T>) => void) | undefined;
    readonly onBlur?: ((event: FocusEvent<T>) => void) | undefined;
}

/** The trigger's own handlers followed by the tooltip's, for a component that has both. */
export function mergeTooltipHandlers<T extends HTMLElement>(
    own: TooltipHandlers<T>,
    tooltip: TooltipTriggerProps,
): Required<TooltipHandlers<T>> {
    return {
        onPointerEnter: (event) => {
            own.onPointerEnter?.(event);
            tooltip.onPointerEnter(event);
        },
        onPointerLeave: (event) => {
            own.onPointerLeave?.(event);
            tooltip.onPointerLeave();
        },
        onFocus: (event) => {
            own.onFocus?.(event);
            tooltip.onFocus(event);
        },
        onBlur: (event) => {
            own.onBlur?.(event);
            tooltip.onBlur();
        },
    };
}
