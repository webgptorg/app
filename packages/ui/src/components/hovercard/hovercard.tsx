import { createContext, use, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, MouseEvent, PointerEvent, ReactNode } from 'react';

/** Spread onto the element the card is about (a chip, a name); it keeps its own role and click action. */
export interface HovercardTriggerProps {
    readonly 'aria-haspopup': 'dialog';
    readonly 'aria-expanded': boolean;
    readonly 'aria-controls': string;
    readonly onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
    readonly onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
    readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    readonly onPointerUp: () => void;
    readonly onPointerCancel: () => void;
    readonly onClickCapture: (event: MouseEvent<HTMLElement>) => void;
    readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
    readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
    readonly onBlur: (event: FocusEvent<HTMLElement>) => void;
}

export interface HovercardState {
    readonly open: boolean;
    readonly triggerProps: HovercardTriggerProps;
    /** Opens it at once at `anchor`, e.g. when a chip is tapped on a touch screen. */
    readonly show: (anchor: HTMLElement) => void;
    readonly hide: () => void;
    /** Render right after the trigger, so Tab moves from the trigger into the card's actions. */
    readonly card: ReactNode;
}

export interface HovercardOptions {
    /** The card's accessible name, e.g. the agent's or task's name. */
    readonly label: string;
    /** Rendered only while open. An action that is done with the card closes it through `useHovercardHide`. */
    readonly content: ReactNode;
    /** Hover intent: a pointer passing over the trigger on its way elsewhere opens nothing. */
    readonly openDelayMs?: number;
}

export const HOVERCARD_OPEN_DELAY_MS = 300;
/** A touch has no hover: holding the trigger this long opens the card instead, as a link preview does on a phone. */
export const HOVERCARD_LONG_PRESS_MS = 500;

const HovercardHideContext = createContext<() => void>(() => undefined);

/** Closes the hovercard around the caller, e.g. after its Mention action has done its job. */
export function useHovercardHide(): () => void {
    return use(HovercardHideContext);
}
/** Long enough to move the pointer from the trigger onto the card (WCAG 1.4.13, hoverable). */
const HIDE_DELAY_MS = 150;
const GAP = 6;
const VIEWPORT_MARGIN = 8;

function place(anchor: DOMRect, card: DOMRect): CSSProperties {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const below = anchor.bottom + GAP + card.height <= viewportHeight - VIEWPORT_MARGIN;
    const top = below ? anchor.bottom + GAP : Math.max(VIEWPORT_MARGIN, anchor.top - GAP - card.height);
    const left = Math.min(
        Math.max(anchor.left, VIEWPORT_MARGIN),
        Math.max(VIEWPORT_MARGIN, viewportWidth - card.width - VIEWPORT_MARGIN),
    );
    return { top, left };
}

function isKeyboardFocus(element: HTMLElement): boolean {
    try {
        return element.matches(':focus-visible');
    } catch {
        return true;
    }
}

/**
 * A small card about the thing under the pointer or the keyboard focus, with actions of its own. It opens after a
 * hover delay, at once on keyboard focus, or on a long press on a touch screen, where a tap stays the trigger's own
 * action. It stays while the pointer or focus is on it, a tap elsewhere closes it, and Esc closes it and puts
 * focus back on the trigger (WCAG 1.4.13). A non-modal dialog in the top layer, placed through the CSSOM so the
 * engine's CSP holds; it closes when the page scrolls, so it never drifts from its trigger.
 */
export function useHovercard({
    label,
    content,
    openDelayMs = HOVERCARD_OPEN_DELAY_MS,
}: HovercardOptions): HovercardState {
    const id = useId();
    const cardRef = useRef<HTMLSpanElement>(null);
    const anchorRef = useRef<HTMLElement | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pressing = useRef<HTMLElement | null>(null);
    // Set once a long press opened the card, so the click that ends the press does not also follow the link.
    const pressed = useRef(false);
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState<CSSProperties | undefined>(undefined);

    const show = useCallback((anchor: HTMLElement) => {
        clearTimeout(timer.current);
        anchorRef.current = anchor;
        setOpen(true);
    }, []);
    const hide = useCallback(() => {
        clearTimeout(timer.current);
        setOpen(false);
    }, []);
    const cancelPress = () => {
        clearTimeout(pressTimer.current);
        pressing.current = null;
    };
    const openByPress = (anchor: HTMLElement) => {
        cancelPress();
        pressed.current = true;
        show(anchor);
    };
    const scheduleHide = (event?: PointerEvent<HTMLElement>) => {
        // A finger leaves the element as it lifts; only a mouse moving away means the card is no longer wanted.
        if (event?.pointerType === 'touch') return;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            setOpen(false);
        }, HIDE_DELAY_MS);
    };
    const cancelHide = () => {
        clearTimeout(timer.current);
    };
    const focusStaysInside = (event: FocusEvent<HTMLElement>) => {
        const next = event.relatedTarget;
        return (
            next instanceof Node &&
            (cardRef.current?.contains(next) === true || anchorRef.current?.contains(next) === true)
        );
    };

    useLayoutEffect(() => {
        const card = cardRef.current;
        const anchor = anchorRef.current;
        if (card === null) return;
        if (!open || anchor === null) {
            card.togglePopover(false);
            return;
        }
        card.togglePopover(true);
        setPosition(place(anchor.getBoundingClientRect(), card.getBoundingClientRect()));
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            // Esc closes the card first; whatever is around it (a dialog, a reply to stop) waits for the next press.
            event.stopPropagation();
            event.preventDefault();
            if (cardRef.current?.contains(document.activeElement) === true) anchorRef.current?.focus();
            setOpen(false);
        };
        const onScroll = (event: Event) => {
            if (event.target instanceof Node && cardRef.current?.contains(event.target) === true) return;
            setOpen(false);
        };
        // A tap elsewhere closes it; a tap may move no focus, so blur alone would leave the card open.
        const onPointerDown = (event: Event) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (cardRef.current?.contains(target) === true || anchorRef.current?.contains(target) === true) return;
            setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('scroll', onScroll, true);
        };
    }, [open]);

    useEffect(
        () => () => {
            clearTimeout(timer.current);
            clearTimeout(pressTimer.current);
        },
        [],
    );

    return {
        open,
        show,
        hide,
        triggerProps: {
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-controls': id,
            onPointerEnter: (event) => {
                // A touch has no hover; the tap is the trigger's own action.
                if (event.pointerType === 'touch') return;
                const anchor = event.currentTarget;
                clearTimeout(timer.current);
                if (open) return;
                timer.current = setTimeout(() => {
                    show(anchor);
                }, openDelayMs);
            },
            onPointerLeave: scheduleHide,
            onPointerDown: (event) => {
                pressed.current = false;
                if (event.pointerType !== 'touch') return;
                const anchor = event.currentTarget;
                cancelPress();
                pressing.current = anchor;
                pressTimer.current = setTimeout(() => {
                    openByPress(anchor);
                }, HOVERCARD_LONG_PRESS_MS);
            },
            // The browser cancels the pointer when the finger starts to scroll, so a scroll never opens the card.
            onPointerUp: cancelPress,
            onPointerCancel: cancelPress,
            onClickCapture: (event) => {
                if (!pressed.current) return;
                pressed.current = false;
                // A press that a phone ended without a click must not swallow the next Enter on the trigger.
                if (event.detail === 0) return;
                event.preventDefault();
                event.stopPropagation();
            },
            // Some phones raise their own link menu for a long press, sometimes before the timer: the card wins.
            onContextMenu: (event) => {
                if (pressing.current !== null) openByPress(pressing.current);
                if (pressed.current) event.preventDefault();
            },
            onFocus: (event) => {
                if (isKeyboardFocus(event.currentTarget)) show(event.currentTarget);
            },
            onBlur: (event) => {
                if (!focusStaysInside(event)) hide();
            },
        },
        card: (
            <span
                ref={cardRef}
                id={id}
                role="dialog"
                aria-label={label}
                popover="manual"
                style={position}
                onPointerEnter={cancelHide}
                onPointerLeave={scheduleHide}
                onBlur={(event) => {
                    if (!focusStaysInside(event)) hide();
                }}
                className="fixed inset-auto m-0 w-max open:block max-w-[min(20rem,calc(100vw-1rem))] rounded-(--hovercard-radius) border border-(--hovercard-border) bg-(--hovercard-bg) p-3 text-start text-sm font-normal whitespace-normal text-(--hovercard-text) shadow-(--hovercard-shadow) motion-safe:animate-fade-in"
            >
                <HovercardHideContext value={hide}>{open ? content : null}</HovercardHideContext>
            </span>
        ),
    };
}

export interface HovercardProps extends HovercardOptions {
    readonly children: (triggerProps: HovercardTriggerProps, state: HovercardState) => ReactNode;
}

/** `useHovercard` for any trigger: the trigger, then its card. */
export function Hovercard({ children, ...options }: HovercardProps) {
    const state = useHovercard(options);
    return (
        <>
            {children(state.triggerProps, state)}
            {state.card}
        </>
    );
}
